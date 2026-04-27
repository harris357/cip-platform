// TODO: Load from Langfuse prompt management in production
export const EXTRACTION_PROMPT = `
You are a construction certification document parser.
Extract the following fields from the provided document image.
Return JSON with keys: holderName, holderEmail, certName, issuingBody,
issueDate (YYYY-MM-DD), expiryDate (YYYY-MM-DD), certNumber.
If a field is not present, omit it. Do not guess.
`;
