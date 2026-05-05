// Slice 53 — confirm-card builders (pure functions, no I/O).
//
// `buildConfirmCard` renders the Slice 46b interrupt payload as an
// Adaptive Card v1.5 with [Confirm] [Cancel] Action.Execute buttons.
// `buildResultCard` renders the post-resolution replacement card that
// the invoke handler returns in the AdaptiveCardInvokeResponse body
// (so Teams replaces the original card in place).
//
// The card carries `turnId, threadId, decision, proposedAt` in
// Action.data — verified user identity (`from.aadObjectId`) is added
// by Teams itself when the click hits the bot. Per the Seven
// Non-Negotiables (rule 6), `tenantId` is NEVER in the card payload.
//
// Why Action.Execute (not Action.Submit):
//   - Click arrives as `adaptiveCard/action` invoke, not a message
//     turn — bypasses the LangGraph runner entirely.
//   - Bot Framework signs `from.aadObjectId` so the handler's
//     wrong-user check is trustworthy.
//   - Returning an AdaptiveCardInvokeResponse body lets Teams replace
//     the card in place (no second message needed for the verdict).

/** Loose Adaptive Card JSON. We deliberately avoid @microsoft/teams.cards
 *  — raw IAdaptiveCard JSON is the contract (see slice doc "Out of scope"). */
export type IAdaptiveCard = Record<string, unknown>;

/** Verb namespace for the confirm gate. See invoke-router.ts for the
 *  `<module>.<feature>.<action>` convention; this is the canonical
 *  consumer. */
export const CONFIRM_VERB = 'bot.write_confirm.respond';

export interface ConfirmCardPayload {
  /** Per-turn UUID slice from runner.newTurnId(). Surfaces in card data
   *  so duplicate clicks can be correlated against the suspended task. */
  turnId:     string;
  /** Teams conversation id — also `thread_id` in PostgresSaver state. */
  threadId:   string;
  /** Human-readable summary, e.g., "Disable Jane Smith". */
  summary:    string;
  toolName:   string;
  toolArgs:   Record<string, unknown>;
  /** ms-since-epoch when the suspension was rendered. TTL'd in the
   *  handler against `lg.confirm_card_ttl_seconds`. */
  proposedAt: number;
  /** Per-arg truncation cap. Reads `lg.confirm_card_max_arg_chars`. */
  maxArgChars: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function valueToFactString(v: unknown, max: number): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return truncate(v, max);
  return truncate(JSON.stringify(v), max);
}

/**
 * Build the confirm card sent when the runner detects an active
 * interrupt and `lg.confirm_render_mode === 'card'`. Pure function —
 * the runner does the I/O.
 */
export function buildConfirmCard(payload: ConfirmCardPayload): IAdaptiveCard {
  const facts: Array<{ title: string; value: string }> = [
    { title: 'Tool', value: truncate(payload.toolName, payload.maxArgChars) },
  ];
  for (const [k, v] of Object.entries(payload.toolArgs)) {
    if (v === undefined || v === null) continue;
    facts.push({ title: k, value: valueToFactString(v, payload.maxArgChars) });
  }

  const baseData = {
    turnId:     payload.turnId,
    threadId:   payload.threadId,
    proposedAt: payload.proposedAt,
  };

  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Confirm action', size: 'Large', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: payload.summary,  wrap: true, spacing: 'Small' },
      { type: 'FactSet',   facts },
    ],
    actions: [
      {
        type:  'Action.Execute',
        verb:  CONFIRM_VERB,
        title: 'Confirm',
        style: 'positive',
        data:  { ...baseData, decision: 'confirm' },
      },
      {
        type:  'Action.Execute',
        verb:  CONFIRM_VERB,
        title: 'Cancel',
        style: 'destructive',
        data:  { ...baseData, decision: 'cancel' },
      },
    ],
    // AI-generated content disclosure (per Microsoft AI UX guidance).
    msteams: { entities: [
      { type: 'https://schema.org/Message', '@type': 'Message', additionalType: ['AIGeneratedContent'] },
    ] },
  };
}

export type ResultDecision =
  | 'confirmed'        // graph resumed with confirm; tool fired
  | 'cancelled'        // graph resumed with cancel
  | 'expired'          // TTL elapsed
  | 'wrong_user'       // someone other than the original caller clicked
  | 'already_handled'  // duplicate click after graph already advanced
  | 'permission_denied'; // permission re-check failed

/**
 * Build the replacement card returned in the AdaptiveCardInvokeResponse
 * body. Skeleton matches the confirm card's body so Teams can swap
 * smoothly; actions are removed (post-resolution, the card is read-only).
 */
export function buildResultCard(decision: ResultDecision, summary: string): IAdaptiveCard {
  const heading = (() => {
    switch (decision) {
      case 'confirmed':         return '✓ Confirmed';
      case 'cancelled':         return '✕ Cancelled';
      case 'expired':           return '⏱ Action expired';
      case 'wrong_user':        return '⚠ Not your action';
      case 'already_handled':   return '⚠ Already handled';
      case 'permission_denied': return '⚠ Not authorised';
    }
  })();

  const subtitle = (() => {
    switch (decision) {
      case 'confirmed':         return summary;
      case 'cancelled':         return `Cancelled: ${summary}`;
      case 'expired':           return `This confirmation expired before you clicked. Please ask again.`;
      case 'wrong_user':        return `Only the user who proposed this action can confirm it.`;
      case 'already_handled':   return `This action was already resolved.`;
      case 'permission_denied': return `You don't have permission to run this action.`;
    }
  })();

  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: heading,  size: 'Large', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: subtitle, wrap: true, spacing: 'Small' },
    ],
    msteams: { entities: [
      { type: 'https://schema.org/Message', '@type': 'Message', additionalType: ['AIGeneratedContent'] },
    ] },
  };
}
