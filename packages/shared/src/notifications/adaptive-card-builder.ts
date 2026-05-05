// Slice infra (pre-58D): generic adaptive-card builder helpers. Returns
// plain objects matching the adaptive-cards 1.4 schema; service-specific
// copy (titles, fact labels, action data) is supplied by the caller.
//
// Factored from the inline `buildHitlCard()` originally in
// hr-service/src/modules/certifications/activities/notify-hitl.activity.ts.

export interface AdaptiveCardFact {
  title: string;
  value: string;
}

export interface AdaptiveCardSubmitAction {
  /** Button label, e.g. 'Approve', 'Reject'. */
  title: string;
  /** Submit-action `data` payload — caller controls the shape. */
  data:  Record<string, unknown>;
}

export interface BuildFactSetCardInput {
  /** Bold heading at the top of the card. */
  heading: string;
  /** Key/value pairs rendered as a FactSet. */
  facts:   AdaptiveCardFact[];
  /** Optional Submit-action buttons rendered at the bottom. */
  actions?: AdaptiveCardSubmitAction[];
}

/**
 * Build a 1.4 adaptive card with a bold heading, a FactSet, and optional
 * Submit actions. Returns the raw card object suitable for passing to
 * `notifyTeamsCard()`.
 */
export function buildFactSetCard(input: BuildFactSetCardInput): object {
  const card: {
    type:    string;
    version: string;
    body:    unknown[];
    actions?: unknown[];
  } = {
    type:    'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type:   'TextBlock',
        text:   input.heading,
        weight: 'Bolder',
        size:   'Medium',
      },
      {
        type:  'FactSet',
        facts: input.facts,
      },
    ],
  };

  if (input.actions && input.actions.length > 0) {
    card.actions = input.actions.map(a => ({
      type:  'Action.Submit',
      title: a.title,
      data:  a.data,
    }));
  }

  return card;
}
