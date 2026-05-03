// Slice 55: disambiguation card builder.
//
// When an extractor returns `kind: 'ambiguous'` (DB resolution returned
// >1 match), respond.ts renders this adaptive card. Each candidate is
// an Action.Submit button; tapping fires `messageBack` carrying enough
// payload that the bot's slash dispatcher can reconstruct the intended
// tool call.
//
// The messageBack payload routes through the existing /disambiguate
// slash command, which is permission-gated like other admin actions.
// Slice 53's full invoke router would be a cleaner long-term home;
// for v1 the messageBack-as-slash pattern reuses existing
// infrastructure.

export interface DisambiguationCardArgs {
  prompt:        string;
  toolName:      string;
  argName:       string;
  partialArgs:   Record<string, unknown>;
  candidates:    Array<{ id: string; label: string; hint?: string }>;
}

export function buildDisambiguationCard(args: DisambiguationCardArgs): unknown {
  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: args.prompt, wrap: true, size: 'Medium', weight: 'Bolder' },
      { type: 'TextBlock', text: `Pick one to proceed:`,                wrap: true, isSubtle: true },
    ],
    actions: args.candidates.slice(0, 5).map(c => ({
      type:  'Action.Submit',
      title: c.hint ? `${c.label} — ${c.hint}` : c.label,
      data: {
        msteams: {
          type:        'messageBack',
          // displayText is what shows in the channel as if the user typed it;
          // text is what the bot receives and dispatches on.
          displayText: `Selected: ${c.label}`,
          text:        `/disambiguate ${args.toolName} ${args.argName}=${c.id}${
            Object.entries(args.partialArgs).length > 0
              ? ' ' + Object.entries(args.partialArgs).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' ')
              : ''
          }`,
        },
      },
    })),
  };
}
