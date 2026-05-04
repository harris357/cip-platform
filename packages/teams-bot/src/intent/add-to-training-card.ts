// Slice 56K: small adaptive card with a single "📚 Add to training set"
// action. Sent alongside the /turn markdown reply. Tap fires the
// follow-up card asking for the labelled example text.
//
// Same messageBack-as-slash-command plumbing as the disambiguation
// card (slice 55), the inspect button (slice 46e), and the verdict
// buttons (slice 56F).

export function buildAddToTrainingActionCard(turnId: string): unknown {
  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type:     'TextBlock',
        text:     `_Promote this turn to a labelled training example?_`,
        wrap:     true,
        size:     'Small',
        isSubtle: true,
      },
    ],
    actions: [
      {
        type:  'Action.Submit',
        title: '📚 Add to training set',
        data: {
          msteams: {
            type:        'messageBack',
            displayText: '📚 Add to training set',
            text:        `/turn-label ${turnId}`,
          },
        },
      },
    ],
  };
}

/**
 * Follow-up card after the user taps "📚 Add to training set". Renders
 * the metrics-derived prefills (intent, tool, next_action) and asks
 * the admin to confirm the user-text label they want to commit.
 */
export interface TurnLabelCardArgs {
  turnId:     string;
  intent:     string;
  tool?:      string | null;
  /** Optional starting text — usually empty so the admin types the
   *  phrasing they want labelled. (We don't auto-pull from Langfuse to
   *  avoid the perception that the bot is silently scraping user text;
   *  admins explicitly type what they want preserved.) */
  prefillText?: string;
}

export function buildTurnLabelCard(args: TurnLabelCardArgs): unknown {
  return {
    type:    'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type:   'TextBlock',
        text:   'Label turn as training data',
        wrap:   true,
        size:   'Medium',
        weight: 'Bolder',
      },
      {
        type:   'TextBlock',
        text:   `_Turn \`${args.turnId}\` — pre-filled from bot_turn_metrics. Edit if needed._`,
        wrap:   true,
        isSubtle: true,
        size:   'Small',
      },
      {
        type:        'Input.Text',
        id:          'text',
        label:       'User phrasing to label',
        placeholder: 'e.g. "show me everyone\'s certs"',
        value:       args.prefillText ?? '',
        isMultiline: true,
        maxLength:   500,
      },
      {
        type:        'Input.Text',
        id:          'intent',
        label:       'Intent',
        placeholder: 'e.g. get_staff_certifications',
        value:       args.intent,
        maxLength:   100,
      },
      {
        type:        'Input.Text',
        id:          'tool',
        label:       'Tool (optional — leave blank for non-tool intents)',
        placeholder: 'e.g. get_staff_certifications',
        value:       args.tool ?? '',
        maxLength:   100,
      },
      {
        type:    'Input.ChoiceSet',
        id:      'next_action',
        label:   'Next action',
        style:   'compact',
        value:   'call_tool',
        choices: [
          { title: 'call_tool',       value: 'call_tool' },
          { title: 'clarify',         value: 'clarify' },
          { title: 'answer_directly', value: 'answer_directly' },
          { title: 'unknown',         value: 'unknown' },
        ],
      },
    ],
    actions: [
      {
        type:  'Action.Submit',
        title: 'Save',
        data: {
          msteams: {
            type:        'messageBack',
            displayText: '📚 (saved training example)',
            // Inputs are interpolated by Teams at submit time.
            text:        `/turn-label-submit ${args.turnId} text="{text}" intent={intent} tool={tool} next_action={next_action}`,
          },
        },
      },
    ],
  };
}
