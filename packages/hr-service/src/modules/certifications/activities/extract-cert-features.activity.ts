// Slice 58C — cert extraction strategy.
// Slice 58C-FIX — text-vs-vision branching.
//
// The doc-service classify+extract phase loop dispatches every
// (module='certificate', doc_type=*) doc here via the cross-queue
// `ExecuteExtractionStrategyWorkflow`. We're the seam between the
// generic ExtractionInput/Output contract and the existing vision
// agent (which has its own historical signature — kept untouched per
// kickoff hard rule).
//
// Branching logic (58C-FIX):
//   - When input.ocrText.length >= lg.cert_text_extraction_min_chars
//     (default 200), call cip-document with the field-extraction
//     prompt. Faster + cheaper + accurate for text-rich PDFs/DOCX/etc.
//   - Below the threshold (sparse text — likely scanned-image), fall
//     through to the existing vision agent. The PDF "data:image/jpeg
//     ;base64,JVBERi…" bug that motivated this slice is dropped: the
//     vision agent only ever sees actual image MIMEs now, since
//     doc-service's PDF extractor handles its own render fallback.
//
// S3 access: hr-service has the same OVH credentials as doc-service
// via the service secret (kickoff correction #5).

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { activityInfo } from '@temporalio/activity';

import {
  ExtractionInputSchema,
  ExtractionOutputSchema,
  type ExtractionInput,
  type ExtractionOutput,
  callLLM,
  createLiteLLMClient,
  getPrompt,
} from '@cip/shared';

import { runVisionAgent } from '../agents/vision-agent/index.js';
import { resolveAlias } from '../../../services/alias-resolver.js';
import { getPool } from '../../../db/index.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_MIN_CHARS = 200;

let _s3: S3Client | undefined;
function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL'];
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION']?.toLowerCase() ?? 'bhs',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    });
  }
  return _s3;
}

/**
 * Map the strategy doc_type string into the certType hint the existing
 * vision agent's prompt template expects.  '*' / 'unknown' / empty all
 * fall through to a neutral 'certificate' hint.
 */
function inferCertTypeHint(docType: string): string {
  if (!docType || docType === '*' || docType === 'unknown') return 'certificate';
  return docType;
}

/**
 * Lightweight tunable read — single key, with the same precedence the
 * doc-service shadow loader uses (per-tenant > zero-UUID > code default).
 * Inlined here so the cert activity doesn't take a dependency on a
 * larger tunables module.
 */
async function readMinChars(tenantId: string): Promise<number> {
  try {
    const pool = getPool();
    const r = await pool.query<{ value_json: unknown }>(
      `SELECT value_json
         FROM bot_tunables
        WHERE key = $1 AND (tenant_id = $2 OR tenant_id = $3::uuid)
        ORDER BY (tenant_id = $2) DESC
        LIMIT 1`,
      ['lg.cert_text_extraction_min_chars', tenantId, ZERO_UUID],
    );
    const v = r.rows[0]?.value_json;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : DEFAULT_MIN_CHARS;
  } catch (err) {
    console.warn(`[extract-cert] tunable read failed: ${err instanceof Error ? err.message : String(err)} — using default ${DEFAULT_MIN_CHARS}`);
    return DEFAULT_MIN_CHARS;
  }
}

const REQUIRED_FIELDS = ['holderName', 'certName', 'issuingBody', 'issueDate', 'expiryDate', 'certNumber'] as const;

export async function extractCertFeaturesActivity(
  input: ExtractionInput,
): Promise<ExtractionOutput> {
  const validated = ExtractionInputSchema.parse(input);

  const minChars = await readMinChars(validated.tenantId);

  const ocrText = validated.ocrText ?? '';

  // ── Text path: doc-service already extracted enough text. ──
  if (ocrText.trim().length >= minChars) {
    const result = await extractCertFromText({
      ocrText,
      tenantId:  validated.tenantId,
      certType:  inferCertTypeHint(validated.docType),
      fileName:  (validated.genericFeatures['fileName'] as string | undefined) ?? '',
    });

    return ExtractionOutputSchema.parse({
      fields:               result.fields,
      extractionConfidence: result.confidence,
      evidence: {
        source:        'cip-document-text',
        modelUsed:     result.modelUsed,
        tokensUsed:    result.tokensUsed,
        promptVersion: result.promptVersion,
        certType:      inferCertTypeHint(validated.docType),
        ocrTextChars:  ocrText.length,
        thresholdMinChars: minChars,
      },
    });
  }

  // ── Vision fallback: ocrText was sparse → run the legacy vision
  // agent. Note: doc-service's PDF extractor renders page-1 → vision
  // BEFORE we get here, so by this point if ocrText is still sparse,
  // it's probably a real image MIME (or both extractor paths gave up).
  // We re-fetch S3 bytes for the vision agent's base64 surface.
  const obj = await getS3().send(new GetObjectCommand({
    Bucket: validated.s3Bucket,
    Key:    validated.s3Key,
  }));
  if (!obj.Body) {
    throw new Error(`extract-cert-features: empty body for s3://${validated.s3Bucket}/${validated.s3Key}`);
  }
  const bytes = await obj.Body.transformToByteArray();
  const documentBase64 = Buffer.from(bytes).toString('base64');

  const info = activityInfo();
  const workflowId = info.workflowExecution?.workflowId ?? `extract-cert-features-${validated.documentId}`;

  const vision = await runVisionAgent({
    tenantId:        validated.tenantId,
    workerId:        ZERO_UUID,
    certificationId: validated.documentId,
    documentBase64,
    certType:        inferCertTypeHint(validated.docType),
    workflowId,
    activityId:      info.activityId,
  });

  return ExtractionOutputSchema.parse({
    fields:               vision.extractedFields,
    extractionConfidence: vision.overallConfidence,
    evidence: {
      source:        'vision-agent',
      modelUsed:     vision.modelUsed,
      promptVersion: vision.promptVersion,
      tokensUsed:    vision.tokensUsed,
      requiresHITL:  vision.requiresHITL,
      certType:      vision.certType,
      ocrTextChars:  ocrText.length,
      thresholdMinChars: minChars,
    },
  });
}

interface TextExtractionResult {
  fields:        Record<string, unknown>;
  confidence:    number;
  modelUsed:     string;
  tokensUsed:    number;
  promptVersion: string;
}

/**
 * Slice 58C-FIX — cert field extraction from pre-extracted text.
 * Calls cip-document (text-only model) with the same prompt template
 * the vision agent uses; returns the same shape (subset of the vision
 * agent's ExtractionResult — fields + confidence + bookkeeping).
 */
async function extractCertFromText(args: {
  ocrText:   string;
  tenantId:  string;
  certType:  string;
  fileName:  string;
}): Promise<TextExtractionResult> {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY'];
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required');

  const client = createLiteLLMClient({ tenantId: args.tenantId, virtualKey });

  // Reuse the vision_extract prompt — same field shape, same JSON-only
  // output contract. The fact that we're not sending an image is
  // immaterial to the prompt content; the prompt asks for fields.
  const alias = await resolveAlias({
    service:  'hr-service',
    purpose:  'cert_text_extract',
    tenantId: args.tenantId,
  });
  const prompt = await getPrompt({
    name:     'hr-service.vision_extract',
    tenantId: args.tenantId,
  });

  const userMessage =
      `File: ${args.fileName}\nCert type hint: ${args.certType}\n\n` +
      `--- DOCUMENT TEXT ---\n${args.ocrText}\n--- END ---\n\n` +
      `Extract all certification fields as JSON.`;

  const response = await callLLM(client, {
    model:        alias,
    purpose:      'hr-service.cert_text_extract',
    promptHandle: prompt,
    tenantId:     args.tenantId,
    messages: [
      { role: 'system', content: prompt.compile() },
      { role: 'user',   content: userMessage },
    ],
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content ?? '';
  let fields: Record<string, unknown> = {};
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      fields = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // Empty fields → low confidence → caller routes to HITL.
    }
  }

  const presentCount = REQUIRED_FIELDS.filter(f => Boolean(fields[f])).length;
  const confidence = presentCount / REQUIRED_FIELDS.length;

  return {
    fields,
    confidence,
    modelUsed:     response.model ?? alias,
    tokensUsed:    response.usage?.total_tokens ?? 0,
    promptVersion: 'v1.0.0',
  };
}
