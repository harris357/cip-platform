import type { HitlReasonCode } from '../../../db/registries.js';

export interface NotifyHitlInput {
  tenantId:       string;
  submissionId:   string;
  hitlReasonCode: HitlReasonCode;
}

export async function notifyHitlActivity(input: NotifyHitlInput): Promise<void> {
  void input;
  throw new Error('not implemented');
}
