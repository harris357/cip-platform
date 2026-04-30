import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { employees } from '../../../db/schema.js';
import { resolveAlias } from '../../../services/alias-resolver.js';
import { nameAliasSet } from './nickname-map.js';

// ── Zod schema ────────────────────────────────────────────────────────────────

export const EmployeeMatchResultSchema = z.object({
  matched:    z.boolean(),
  employeeId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  method:     z.enum(['exact_email', 'fuzzy_name', 'llm_tiebreaker', 'no_match']),
});

export type EmployeeMatchResult = z.infer<typeof EmployeeMatchResultSchema>;

// ── Public types (legacy aliases kept for workflow compatibility) ──────────────

export interface MatchEmployeeInput {
  tenantId:     string;
  submissionId: string;
  extraction:   ExtractionResult;
}

export type MatchEmployeeOutput = EmployeeMatchResult;

// ── Name parsing helpers ──────────────────────────────────────────────────────

function parseName(fullName: string): { first: string; last: string } | null {
  const trimmed = fullName.trim();
  if (trimmed.includes(',')) {
    const commaIdx = trimmed.indexOf(',');
    const last  = trimmed.slice(0, commaIdx).trim();
    const first = trimmed.slice(commaIdx + 1).trim().split(/\s+/)[0] ?? '';
    if (!last || !first) return null;
    return { first, last };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts[parts.length - 1]! };
}

function fuzzyFirstNameMatch(a: string, b: string): boolean {
  const aSet = nameAliasSet(a);
  const bSet = nameAliasSet(b);
  for (const av of aSet) {
    if (bSet.has(av)) return true;
  }
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower.length >= 3 && bLower.startsWith(aLower)) return true;
  if (bLower.length >= 3 && aLower.startsWith(bLower)) return true;
  return false;
}

function scoreEmployee(
  employee: { fullName: string; givenName: string | null; surname: string | null },
  parsed: { first: string; last: string },
): number {
  const candidateSurname  = (employee.surname  ?? parseName(employee.fullName)?.last  ?? '').toLowerCase();
  const candidateFirst    = (employee.givenName ?? parseName(employee.fullName)?.first ?? '').toLowerCase();
  const targetSurname     = parsed.last.toLowerCase();
  const targetFirst       = parsed.first.toLowerCase();

  if (!candidateSurname || !candidateFirst) return 0;

  const surnameScore    = candidateSurname === targetSurname ? 0.5 : 0;
  const firstNameScore  = fuzzyFirstNameMatch(targetFirst, candidateFirst) ? 0.5 : 0;
  return surnameScore + firstNameScore;
}

// ── LLM tiebreaker ────────────────────────────────────────────────────────────

type EmployeeRow = { id: string; fullName: string; email: string };

async function llmSelectEmployee(
  tenantId: string,
  virtualKey: string,
  extractedName: string | null,
  extractedEmail: string | null,
  candidates: EmployeeRow[],
): Promise<string | null> {
  const client = createLiteLLMClient({ tenantId, virtualKey });
  const alias = await resolveAlias({ service: 'hr-service', purpose: 'employee_match', tenantId });
  const prompt = await getPrompt({ name: 'hr-service.employee_match', tenantId });

  const list = candidates
    .map((e, i) => `${i + 1}. REF=${i + 1} | Name="${e.fullName}" | Email="${e.email}"`)
    .join('\n');

  const promptText = prompt.compile({
    extractedName:  extractedName ?? '(not found)',
    extractedEmail: extractedEmail ?? '(not found)',
    candidates:     list,
  });

  const response = await callLLM(client, {
    model:        alias,
    max_tokens:   8,
    messages:     [{ role: 'user', content: promptText }],
    purpose:      'hr-service.employee_match',
    promptHandle: prompt,
    tenantId,
  });

  const text = response.choices[0]?.message.content?.trim() ?? 'NO_MATCH';
  if (text === 'NO_MATCH') return null;

  const refNum = parseInt(text, 10);
  if (isNaN(refNum) || refNum < 1 || refNum > candidates.length) return null;
  return candidates[refNum - 1]!.id;
}

// ── Main activity ─────────────────────────────────────────────────────────────

export async function matchEmployee(
  input: MatchEmployeeInput,
): Promise<MatchEmployeeOutput> {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY'];
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required');

  const { tenantId, extraction } = input;
  const db = getDb();

  const holderEmail = extraction.extractedFields['holderEmail'] as string | null | undefined;
  const holderName  = extraction.extractedFields['holderName']  as string | null | undefined;

  // ── Pass 1: Exact email ──────────────────────────────────────────────────
  if (holderEmail) {
    const rows = await withTenantRLS(db, tenantId, (tx) =>
      tx
        .select({ id: employees.id, fullName: employees.fullName, email: employees.email })
        .from(employees)
        .where(eq(employees.email, holderEmail.toLowerCase()))
        .limit(2),
    );

    if (rows.length === 1) {
      return EmployeeMatchResultSchema.parse({
        matched:    true,
        employeeId: rows[0]!.id,
        confidence: 1.0,
        method:     'exact_email',
      });
    }

    if (rows.length > 1) {
      const picked = await llmSelectEmployee(tenantId, virtualKey, holderName ?? null, holderEmail, rows);
      return EmployeeMatchResultSchema.parse({
        matched:    picked !== null,
        employeeId: picked ?? undefined,
        confidence: picked !== null ? 0.9 : 0,
        method:     picked !== null ? 'llm_tiebreaker' : 'no_match',
      });
    }
  }

  // ── Pass 2: Fuzzy name ───────────────────────────────────────────────────
  if (holderName) {
    const parsed = parseName(holderName);
    if (parsed) {
      const allEmployees = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            id:        employees.id,
            fullName:  employees.fullName,
            email:     employees.email,
            givenName: employees.givenName,
            surname:   employees.surname,
          })
          .from(employees),
      );

      const scored = allEmployees
        .map((e) => ({ e, score: scoreEmployee(e, parsed) }))
        .filter(({ score }) => score >= 0.5)
        .sort((a, b) => b.score - a.score);

      const highConfidence = scored.filter(({ score }) => score >= 0.8);
      if (highConfidence.length === 1) {
        return EmployeeMatchResultSchema.parse({
          matched:    true,
          employeeId: highConfidence[0]!.e.id,
          confidence: highConfidence[0]!.score,
          method:     'fuzzy_name',
        });
      }

      // ── Pass 3: LLM tiebreaker ─────────────────────────────────────────
      if (scored.length > 1) {
        const candidates: EmployeeRow[] = scored.map(({ e }) => ({
          id: e.id, fullName: e.fullName, email: e.email,
        }));
        const picked = await llmSelectEmployee(tenantId, virtualKey, holderName, holderEmail ?? null, candidates);
        const matchedScore = picked !== null
          ? (scored.find(({ e }) => e.id === picked)?.score ?? 0.7)
          : 0;
        return EmployeeMatchResultSchema.parse({
          matched:    picked !== null,
          employeeId: picked ?? undefined,
          confidence: matchedScore,
          method:     picked !== null ? 'llm_tiebreaker' : 'no_match',
        });
      }
    }
  }

  return EmployeeMatchResultSchema.parse({
    matched:    false,
    confidence: 0,
    method:     'no_match',
  });
}
