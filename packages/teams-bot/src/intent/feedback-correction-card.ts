// Slice 56F: 👎 follow-up card — asks "what should it have done?"
//
// Appears after the user taps 👎 on a response-footer card. The user
// types a correction (and/or selects a checkbox category) and taps
// Submit; the card's Action.Submit fires `messageBack` carrying
// `/turn-feedback <id> negative <text>`, which the slash dispatcher
// routes back to the same handler that this card was rendered from.
//
// Same `messageBack → slash command` plumbing as slice 55's
// disambiguation-card.ts and slice 46e's debug-banner inspect button.

export interface FeedbackCorrectionCardArgs {
  turnId: string;
}

export function buildFeedbackCorrectionCard(args: FeedbackCorrectionCardArgs): unknown {
  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type:   'TextBlock',
        text:   'What should it have done?',
        wrap:   true,
        size:   'Medium',
        weight: 'Bolder',
      },
      {
        type:   'TextBlock',
        text:   '_Optional — your correction text becomes a labelled training example._',
        wrap:   true,
        isSubtle: true,
        size:   'Small',
      },
      {
        type:        'Input.Text',
        id:          'correction',
        placeholder: 'e.g. should have called employee_disable',
        isMultiline: true,
        maxLength:   500,
      },
      {
        type:    'Input.ChoiceSet',
        id:      'category',
        style:   'compact',
        isMultiSelect: false,
        placeholder:   'Category (optional)',
        choices: [
          { title: 'Wrong tool',         value: 'wrong_tool' },
          { title: 'Wrong arguments',    value: 'wrong_args' },
          { title: 'Should have asked me', value: 'should_have_asked' },
          { title: 'Off-topic / unknown', value: 'out_of_scope' },
          { title: 'Other',              value: 'other' },
        ],
      },
    ],
    actions: [
      {
        type:  'Action.Submit',
        title: 'Submit',
        data: {
          msteams: {
            type:        'messageBack',
            displayText: '👎 (with correction)',
            // The "{correction}" / "{category}" placeholders are replaced
            // by Teams with the input field values at submit-time. If the
            // user leaves the textarea blank, correction is empty — the
            // handler then records the verdict-only path.
            text:        `/turn-feedback ${args.turnId} negative {correction}`,
          },
        },
      },
      {
        type:  'Action.Submit',
        title: 'Skip',
        data: {
          msteams: {
            type:        'messageBack',
            displayText: '👎',
            // Verdict-only — no correction text. Handler records
            // verdict='negative' with correction=null.
            text:        `/turn-feedback ${args.turnId} negative`,
          },
        },
      },
    ],
  };
}
