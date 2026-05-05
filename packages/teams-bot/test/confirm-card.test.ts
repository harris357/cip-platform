// Slice 53 — confirm-card builder unit tests.
//
// Both builders are pure functions; we assert the JSON structure
// rather than rendering against an actual Teams client.

import { describe, it, expect } from 'vitest';
import {
  buildConfirmCard,
  buildResultCard,
  CONFIRM_VERB,
  type ConfirmCardPayload,
  type ResultDecision,
} from '../src/teams-protocol/cards/confirm.js';

const SAMPLE: ConfirmCardPayload = {
  turnId:     'abc12345',
  threadId:   '19:meeting_abc@thread.tacv2',
  summary:    'Disable Jane Smith',
  toolName:   'disable_employee',
  toolArgs:   { employeeId: 'emp-123', reason: 'left the org' },
  proposedAt: 1714752000000,
  maxArgChars: 50,
};

describe('buildConfirmCard', () => {
  it('builds a v1.5 AdaptiveCard with [Confirm] [Cancel] Action.Execute buttons', () => {
    const card = buildConfirmCard(SAMPLE) as Record<string, unknown>;
    expect(card['type']).toBe('AdaptiveCard');
    expect(card['version']).toBe('1.5');

    const actions = card['actions'] as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0]?.['type']).toBe('Action.Execute');
    expect(actions[0]?.['verb']).toBe(CONFIRM_VERB);
    expect(actions[0]?.['title']).toBe('Confirm');
    expect(actions[1]?.['title']).toBe('Cancel');
  });

  it('passes turnId, threadId, decision, proposedAt in action.data', () => {
    const card = buildConfirmCard(SAMPLE) as Record<string, unknown>;
    const actions = card['actions'] as Array<Record<string, unknown>>;
    expect(actions[0]?.['data']).toEqual({
      turnId:     'abc12345',
      threadId:   '19:meeting_abc@thread.tacv2',
      proposedAt: 1714752000000,
      decision:   'confirm',
    });
    expect(actions[1]?.['data']).toEqual({
      turnId:     'abc12345',
      threadId:   '19:meeting_abc@thread.tacv2',
      proposedAt: 1714752000000,
      decision:   'cancel',
    });
  });

  it('does NOT include tenantId in action.data (Non-Negotiable #6)', () => {
    const card = buildConfirmCard(SAMPLE) as Record<string, unknown>;
    const actions = card['actions'] as Array<Record<string, unknown>>;
    for (const a of actions) {
      const d = a['data'] as Record<string, unknown>;
      expect(d).not.toHaveProperty('tenantId');
    }
  });

  it('renders summary and a FactSet with tool args', () => {
    const card = buildConfirmCard(SAMPLE) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    // [0] heading, [1] summary, [2] FactSet
    expect(body[1]?.['text']).toBe('Disable Jane Smith');
    const factSet = body[2] as { type: string; facts: Array<{ title: string; value: string }> };
    expect(factSet.type).toBe('FactSet');
    expect(factSet.facts).toEqual(expect.arrayContaining([
      { title: 'Tool',       value: 'disable_employee' },
      { title: 'employeeId', value: 'emp-123' },
      { title: 'reason',     value: 'left the org' },
    ]));
  });

  it('truncates long arg values to maxArgChars', () => {
    const longText = 'x'.repeat(500);
    const card = buildConfirmCard({ ...SAMPLE, toolArgs: { note: longText } }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    const factSet = body[2] as { facts: Array<{ title: string; value: string }> };
    const noteFact = factSet.facts.find(f => f.title === 'note')!;
    expect(noteFact.value.length).toBe(SAMPLE.maxArgChars);
    expect(noteFact.value.endsWith('…')).toBe(true);
  });

  it('renders non-string args via JSON.stringify (also truncated)', () => {
    const card = buildConfirmCard({ ...SAMPLE, toolArgs: { count: 7, flags: ['a', 'b'] } }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    const factSet = body[2] as { facts: Array<{ title: string; value: string }> };
    expect(factSet.facts.find(f => f.title === 'count')?.value).toBe('7');
    expect(factSet.facts.find(f => f.title === 'flags')?.value).toBe('["a","b"]');
  });

  it('skips args with null/undefined values', () => {
    const card = buildConfirmCard({
      ...SAMPLE,
      toolArgs: { kept: 'x', skipped_null: null, skipped_undef: undefined },
    }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    const factSet = body[2] as { facts: Array<{ title: string }> };
    const titles = factSet.facts.map(f => f.title);
    expect(titles).toContain('kept');
    expect(titles).not.toContain('skipped_null');
    expect(titles).not.toContain('skipped_undef');
  });

  it('declares AIGeneratedContent disclosure entity', () => {
    const card = buildConfirmCard(SAMPLE) as Record<string, unknown>;
    const msteams = card['msteams'] as { entities: Array<Record<string, unknown>> };
    expect(msteams.entities).toBeDefined();
    expect(msteams.entities[0]?.['additionalType']).toEqual(['AIGeneratedContent']);
  });
});

describe('buildResultCard', () => {
  const decisions: ResultDecision[] = [
    'confirmed', 'cancelled', 'expired', 'wrong_user', 'already_handled', 'permission_denied',
  ];

  it.each(decisions)('builds a card for %s with no actions (read-only)', (decision) => {
    const card = buildResultCard(decision, 'Disable Jane Smith') as Record<string, unknown>;
    expect(card['type']).toBe('AdaptiveCard');
    expect(card['version']).toBe('1.5');
    expect(card['actions']).toBeUndefined();
    const body = card['body'] as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    // heading + subtitle
    expect(typeof body[0]?.['text']).toBe('string');
    expect(typeof body[1]?.['text']).toBe('string');
  });

  it('uses different headings per decision', () => {
    const headings = decisions.map(d => {
      const card = buildResultCard(d, 'x') as Record<string, unknown>;
      return ((card['body'] as Array<Record<string, unknown>>)[0]?.['text']) as string;
    });
    // Distinct: every decision has its own heading.
    expect(new Set(headings).size).toBe(decisions.length);
  });

  it('embeds the summary in confirmed/cancelled subtitles', () => {
    const ok = buildResultCard('confirmed', 'Disable Jane Smith') as Record<string, unknown>;
    const cancel = buildResultCard('cancelled', 'Disable Jane Smith') as Record<string, unknown>;
    expect(((ok['body'] as Array<Record<string, unknown>>)[1]?.['text'])).toContain('Disable Jane Smith');
    expect(((cancel['body'] as Array<Record<string, unknown>>)[1]?.['text'])).toContain('Disable Jane Smith');
  });
});

import { classifyConfirmReply } from '../src/langgraph/util/classify-confirm-reply.js';

describe('classifyConfirmReply (slice 53 union extension)', () => {
  const affirm = ['yes', 'y', 'do it'];
  const cancel = ['no', 'n', 'stop'];

  it('text mode: matches existing affirmation patterns', () => {
    expect(classifyConfirmReply('yes', affirm, cancel)).toBe('affirm');
    expect(classifyConfirmReply('do it now', affirm, cancel)).toBe('affirm');
    expect(classifyConfirmReply('absolutely not', affirm, cancel)).toBe('unrecognized');
  });

  it('text mode: matches existing cancellation patterns', () => {
    expect(classifyConfirmReply('no', affirm, cancel)).toBe('cancel');
    expect(classifyConfirmReply('stop please', affirm, cancel)).toBe('cancel');
  });

  it('card mode: { decision: "confirm" } short-circuits to affirm', () => {
    expect(classifyConfirmReply({ decision: 'confirm' }, [], [])).toBe('affirm');
  });

  it('card mode: { decision: "cancel" } short-circuits to cancel', () => {
    expect(classifyConfirmReply({ decision: 'cancel' }, [], [])).toBe('cancel');
  });
});
