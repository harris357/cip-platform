import { z } from 'zod';

export interface PreClassifyCertInput {
  tenantId: string;
  documentBase64: string;
}

export interface PreClassifyCertOutput {
  certTypeHint: string;
}

const PreClassifyCertOutputSchema = z.object({
  certTypeHint: z.string().min(1),
});

// Keyword-to-certType map — evaluated against the first 2 KB of decoded text.
const KEYWORD_MAP: Array<[RegExp, string]> = [
  [/\bwhmis\b/i,                             'WHMIS'],
  [/\bfirst[\s-]?aid\b/i,                    'FIRST_AID'],
  [/\bcpr\b/i,                               'CPR'],
  [/\bfall\s+protection\b/i,                 'FALL_PROTECTION'],
  [/\bconfined\s+space\b/i,                  'CONFINED_SPACE'],
  [/\bforklift\b|\blift\s+truck\b/i,         'FORKLIFT'],
  [/\bscaffold\b/i,                          'SCAFFOLD'],
  [/\belectrical\s+safety\b/i,               'ELECTRICAL_SAFETY'],
  [/\bh2s\s+alive\b|\bhazardous\s+gas\b/i,   'H2S'],
  [/\bworking\s+at\s+heights?\b/i,           'WORKING_AT_HEIGHTS'],
  [/\borientation\b/i,                       'SITE_ORIENTATION'],
];

export async function preClassifyCertActivity(
  input: PreClassifyCertInput,
): Promise<PreClassifyCertOutput> {
  // Decode first 2 KB for text hinting — decoding the full document is unnecessary
  const raw = Buffer.from(input.documentBase64, 'base64');
  const preview = raw.subarray(0, 2048).toString('latin1');

  let certTypeHint = 'UNKNOWN';
  for (const [pattern, certType] of KEYWORD_MAP) {
    if (pattern.test(preview)) {
      certTypeHint = certType;
      break;
    }
  }

  return PreClassifyCertOutputSchema.parse({ certTypeHint });
}
