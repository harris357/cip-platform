import Langfuse from 'langfuse';

let _instance: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (_instance) return _instance;

  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  const baseUrl   = process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    throw new Error('Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY');
  }

  _instance = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 10, flushInterval: 5000 });
  return _instance;
}

export async function shutdownLangfuse(): Promise<void> {
  if (_instance) {
    await _instance.shutdownAsync();
    _instance = null;
  }
}
