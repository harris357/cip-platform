// Slice 56: HTTP client for the intent-classifier service.
//
// Calls POST /classify with a hard timeout (lg.classifier_timeout_ms,
// default 500). Failures and timeouts return null so the bot's
// classify graph node treats them as fallthrough — no turn fails
// because of the classifier.

import type { State } from '../langgraph/state.js';

export interface ClassifierPrediction {
  intent:             string;
  next_action:        'call_tool' | 'clarify' | 'answer_directly' | 'unknown';
  tool:               string | null;
  confidence:         number;
  scores:             Record<string, number>;
  normalized:         string;
  classifier_version: string;
}

export async function classifyMessage(args: {
  serviceUrl: string;
  text:       string;
  tenantId:   string;
  turnId:     string;
  timeoutMs:  number;
}): Promise<ClassifierPrediction | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    const resp = await fetch(`${args.serviceUrl}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text:       args.text,
        tenant_id:  args.tenantId,
        request_id: args.turnId,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.warn(`[classifier-client] non-ok response ${resp.status}`);
      return null;
    }
    return await resp.json() as ClassifierPrediction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[classifier-client] ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Re-export State type for consumers that need it together with the prediction.
export type { State };
