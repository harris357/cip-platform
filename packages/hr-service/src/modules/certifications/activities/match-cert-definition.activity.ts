import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { callLLM, createLiteLLMClient } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { certificateDefinitions } from '../../../db/schema.js';
import { resolveAlias } from '../../../services/alias-resolver.js';

// ── Zod schema ────────────────────────────────────────────────────────────────

export const CertDefMatchResultSchema = z.object({
  matched:   z.boolean(),
  certDefId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  method:    z.enum(['word_overlap', 'llm_selection', 'no_match']),
});

export type CertDefMatchResult = z.infer<typeof CertDefMatchResultSchema>;

// ── Public types (legacy aliases kept for workflow compatibility) ──────────────

export interface MatchCertDefinitionInput {
  tenantId:     string;
  submissionId: string;
  extraction:   ExtractionResult;
}

export type MatchCertDefinitionOutput = CertDefMatchResult;

// ── Scoring helpers ───────────────────────────────────────────────────────────

function tokenise(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 1),
  );
}

function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

type CertRow = {
  id:          string;
  displayName: string;
  keywords:    string[];
};

function bestOverlapScore(cert: CertRow, queryTokens: Set<string>): number {
  const nameScore = jaccardScore(tokenise(cert.displayName), queryTokens);
  const keywordScore = cert.keywords.length > 0
    ? Math.max(...cert.keywords.map((kw) => jaccardScore(tokenise(kw), queryTokens)))
    : 0;
  return Math.max(nameScore, keywordScore);
}

// ── LLM selection ─────────────────────────────────────────────────────────────

async function llmSelectCertDef(
  tenantId: string,
  virtualKey: string,
  certName: string,
  allCerts: CertRow[],
): Promise<string | null> {
  const client = createLiteLLMClient({ tenantId, virtualKey });
  const alias = await resolveAlias({ service: 'hr-service', purpose: 'cert_def_match', tenantId });

  const library = allCerts
    .map((c, i) => `${i + 1}. REF=${i + 1} | "${c.displayName}"`)
    .join('\n');

  const prompt = `Match a certificate name extracted via OCR to a certificate library.

Extracted name (may contain OCR errors or abbreviations):
  "${certName}"

Certificate library:
${library}

If one entry is clearly the same certificate, reply with ONLY its REF number (the integer after "REF=").
Common variations to recognise: abbreviations (WHMIS, H2S, CPR), OCR errors, reordered words.
If you are not confident, reply with exactly: NO_MATCH
Do not explain.`;

  const response = await callLLM(client, {
    model:      alias,
    max_tokens: 8,
    messages:   [{ role: 'user', content: prompt }],
    purpose:    'hr-service.cert_def_match',
    tenantId,
  });

  const text = response.choices[0]?.message.content?.trim() ?? 'NO_MATCH';
  if (text === 'NO_MATCH') return null;

  const refNum = parseInt(text, 10);
  if (isNaN(refNum) || refNum < 1 || refNum > allCerts.length) return null;
  return allCerts[refNum - 1]!.id;
}

// ── Main activity ─────────────────────────────────────────────────────────────

export async function matchCertDefinition(
  input: MatchCertDefinitionInput,
): Promise<MatchCertDefinitionOutput> {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY'];
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required');

  const { tenantId, extraction } = input;
  const db = getDb();

  const certName = extraction.extractedFields['certName'] as string | null | undefined;
  if (!certName) {
    return CertDefMatchResultSchema.parse({ matched: false, confidence: 0, method: 'no_match' });
  }

  const queryTokens = tokenise(certName);

  const allDefs = await withTenantRLS(db, tenantId, (tx) =>
    tx
      .select({
        id:          certificateDefinitions.id,
        displayName: certificateDefinitions.displayName,
        keywords:    certificateDefinitions.keywords,
      })
      .from(certificateDefinitions)
      .where(eq(certificateDefinitions.isActive, true)),
  );

  // ── Pass 1: Word overlap ─────────────────────────────────────────────────
  const scored = allDefs
    .map((def) => ({ def, score: bestOverlapScore(def, queryTokens) }))
    .filter(({ score }) => score >= 0.6)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const best = scored[0]!;
    return CertDefMatchResultSchema.parse({
      matched:    true,
      certDefId:  best.def.id,
      confidence: best.score,
      method:     'word_overlap',
    });
  }

  // ── Pass 2: LLM selection ────────────────────────────────────────────────
  const picked = await llmSelectCertDef(tenantId, virtualKey, certName, allDefs);
  if (!picked) {
    return CertDefMatchResultSchema.parse({ matched: false, confidence: 0, method: 'no_match' });
  }

  return CertDefMatchResultSchema.parse({
    matched:    true,
    certDefId:  picked,
    confidence: 0.7,
    method:     'llm_selection',
  });
}
