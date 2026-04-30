// Slice 41: idempotent uploader for the prompts in
// @cip/shared/src/clients/prompts/. Run once after a fresh Langfuse
// project to populate the `production` label.
//
// Usage (workspace-relative — needs @cip/shared's deps):
//   LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… LANGFUSE_HOST=… \
//     pnpm --filter @cip/shared run seed-prompts
//
// Or via bootstrap.sh — runs automatically on every `make bootstrap` /
// `make start`. Re-running with the same text is a no-op (Langfuse
// dedupes by content hash). Re-running with edited text creates a new
// version under the same `production` label.

import Langfuse from 'langfuse';
import { FALLBACKS } from '../src/clients/prompts/index.js';

async function main(): Promise<void> {
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  const baseUrl   = process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    console.error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required');
    process.exit(1);
  }

  const lf = new Langfuse({ publicKey, secretKey, baseUrl });

  for (const [name, text] of Object.entries(FALLBACKS)) {
    const created = await lf.createPrompt({
      name,
      type:   'text',
      prompt: text,
      labels: ['production'],
    });
    console.log(`[seed] ${name} → version ${created.version}`);
  }

  await lf.shutdownAsync();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
