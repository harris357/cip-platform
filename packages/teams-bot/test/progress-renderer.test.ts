// Slice 58B-2b — progress event formatter unit tests.
//
// Pure function: BotProgressEvent → user-facing string (or null when
// the event is too noisy to surface). Subscription bookkeeping is
// covered live in the cluster smoke test.

import { describe, it, expect } from 'vitest';
import type { BotProgressEvent } from '@cip/shared';
import { formatProgressEvent } from '../src/teams-protocol/progress-renderer.js';

const BASE: Pick<BotProgressEvent, 'documentId' | 'tenantId' | 'conversationId' | 'occurredAt'> = {
  documentId:     '00000000-0000-0000-0000-000000000001',
  tenantId:       '00000000-0000-0000-0000-000000000002',
  conversationId: 'conv-1',
  occurredAt:     '2026-05-05T00:00:00.000Z',
};

describe('formatProgressEvent', () => {
  it('starts and ends scan happily', () => {
    expect(formatProgressEvent({ ...BASE, step: 'scan', status: 'started' }))
      .toMatch(/scanning/i);
    expect(formatProgressEvent({ ...BASE, step: 'scan', status: 'completed' }))
      .toMatch(/scan complete/i);
  });

  it('surfaces threat name on scan failure', () => {
    const out = formatProgressEvent({
      ...BASE, step: 'scan', status: 'failed',
      detail: { threat: 'EICAR-TEST' },
    });
    expect(out).toMatch(/eicar/i);
  });

  it('renders page count on generic_features completion', () => {
    expect(formatProgressEvent({
      ...BASE, step: 'generic_features', status: 'completed',
      detail: { pageCount: 1 },
    })).toMatch(/1 page/);
    expect(formatProgressEvent({
      ...BASE, step: 'generic_features', status: 'completed',
      detail: { pageCount: 4 },
    })).toMatch(/4 pages/);
  });

  it('reports the final tier on sensitivity completion', () => {
    expect(formatProgressEvent({
      ...BASE, step: 'sensitivity', status: 'completed',
      detail: { tier: 'confidential' },
    })).toMatch(/confidential/);
  });

  it('skips noisy started events for late phases', () => {
    expect(formatProgressEvent({ ...BASE, step: 'classify', status: 'started' }))
      .toBeNull();
  });

  it('returns generic failed text when no copy is defined', () => {
    expect(formatProgressEvent({ ...BASE, step: 'embedding', status: 'failed' }))
      .toMatch(/embedding failed/i);
  });
});
