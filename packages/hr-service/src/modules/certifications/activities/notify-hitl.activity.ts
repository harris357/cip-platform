// Cert-side adapter for the generic Teams notifier. Holds the cert-specific
// HITL copy (heading, fact labels, approve/reject action shape) and delegates
// delivery to @cip/shared's notifyTeamsCard.
//
// The generic notifier and card builder were extracted to @cip/shared so
// slice 58D (subject HITL), 58F (reclassification), and 58H (classifier
// admin review) can reuse the same path with their own copy.

import {
  notifyTeamsCard,
  buildFactSetCard,
} from '@cip/shared';
import type { HitlReasonCode } from '../../../db/registries.js';

export interface NotifyHitlInput {
  tenantId:       string;
  submissionId:   string;
  hitlReasonCode: HitlReasonCode;
}

function buildHitlCard(input: NotifyHitlInput): object {
  return buildFactSetCard({
    heading: 'Manual Review Required',
    facts: [
      { title: 'Submission', value: input.submissionId },
      { title: 'Reason',     value: input.hitlReasonCode },
      { title: 'Tenant',     value: input.tenantId },
    ],
    actions: [
      { title: 'Approve', data: { action: 'approve', submissionId: input.submissionId } },
      { title: 'Reject',  data: { action: 'reject',  submissionId: input.submissionId } },
    ],
  });
}

export async function notifyHitlActivity(input: NotifyHitlInput): Promise<void> {
  await notifyTeamsCard({
    tenantId:    input.tenantId,
    channelType: 'hitl',
    card:        buildHitlCard(input),
  });
}
