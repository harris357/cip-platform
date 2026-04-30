// Slice 41: fallback for `hr-service.vision_extract`. Byte-identical to
// packages/hr-service/src/modules/certifications/agents/vision-agent/prompts.ts
// EXTRACTION_PROMPT at slice-introduction time.

export const HR_VISION_EXTRACT = `
You are a construction certification document parser.
Extract the following fields from the provided document image.
Return JSON with keys: holderName, holderEmail, certName, issuingBody,
issueDate (YYYY-MM-DD), expiryDate (YYYY-MM-DD), certNumber.
If a field is not present, omit it. Do not guess.
`.trim();
