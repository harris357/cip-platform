// Slice 58B-2b — multi-server client unit tests.
//
// Focus is the toolName → server routing table:
//   - same (name, server) reset works idempotently
//   - same name on a second server throws (hard rule #1)

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setToolRouting,
  getServerForTool,
  _resetMultiServerCaches,
} from '../src/mcp/multi-server-client.js';

describe('setToolRouting', () => {
  beforeEach(() => {
    _resetMultiServerCaches();
  });

  it('records first registration', () => {
    setToolRouting('document_process', 'document-service');
    expect(getServerForTool('document_process')).toBe('document-service');
  });

  it('is idempotent for the same (name, server)', () => {
    setToolRouting('document_process', 'document-service');
    setToolRouting('document_process', 'document-service');
    expect(getServerForTool('document_process')).toBe('document-service');
  });

  it('throws on collision across different servers', () => {
    setToolRouting('frobnicate', 'hr-service');
    expect(() => setToolRouting('frobnicate', 'document-service'))
      .toThrowError(/collision/);
  });

  it('returns undefined for unknown tools', () => {
    expect(getServerForTool('does_not_exist')).toBeUndefined();
  });
});
