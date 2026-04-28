import type { HitlReasonCode } from '../../../db/registries.js';

export interface NotifyHitlInput {
  tenantId:       string;
  submissionId:   string;
  hitlReasonCode: HitlReasonCode;
}

function buildHitlCard(input: NotifyHitlInput): object {
  return {
    type:    'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Manual Review Required',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Submission', value: input.submissionId },
          { title: 'Reason',     value: input.hitlReasonCode },
          { title: 'Tenant',     value: input.tenantId },
        ],
      },
    ],
    actions: [
      { type: 'Action.Submit', title: 'Approve', data: { action: 'approve', submissionId: input.submissionId } },
      { type: 'Action.Submit', title: 'Reject',  data: { action: 'reject',  submissionId: input.submissionId } },
    ],
  };
}

export async function notifyHitlActivity(input: NotifyHitlInput): Promise<void> {
  const botUrl = process.env['TEAMS_BOT_URL'] ?? 'http://teams-bot:3978';
  const url = `${botUrl}/proactive`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId:    input.tenantId,
      channelType: 'hitl',
      card: buildHitlCard(input),
    }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`notifyHitlActivity: POST ${url} returned ${response.status}`);
  }
  // 404 means no channel registered yet — not a fatal error; HITL card will be
  // delivered once the channel is registered on the next user interaction.
}
