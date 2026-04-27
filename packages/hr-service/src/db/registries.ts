import { LookupRegistry } from '@cip/shared'
import { getDb } from './index.js'
import { hitlReasons, hitlResolutions, notificationTypes, workflowStepNames } from './schema.js'

export type HitlReasonCode =
  | 'low_confidence' | 'ambiguous_person' | 'ambiguous_cert_type'
  | 'expired_document' | 'illegible_document' | 'manual_review'

export type HitlResolutionCode = 'approved' | 'corrected' | 'rejected'

export type NotificationTypeCode =
  | 'cert_processed' | 'cert_expiring_soon' | 'cert_expired'
  | 'hitl_required'  | 'hitl_resolved' | 'onboarding_complete' | 'hr_message_sent'

export type WorkflowStepNameCode =
  | 'fetch_document' | 'pre_classify' | 'vision_extraction'
  | 'match_employee' | 'match_cert_definition' | 'persist_certification' | 'send_notification'

export interface HrRegistries {
  hitlReasons:       LookupRegistry<HitlReasonCode>
  hitlResolutions:   LookupRegistry<HitlResolutionCode>
  notificationTypes: LookupRegistry<NotificationTypeCode>
  workflowStepNames: LookupRegistry<WorkflowStepNameCode>
}

export async function loadHrRegistries(): Promise<HrRegistries> {
  const db = getDb()
  const [reasons, resolutions, notifTypes, stepNames] = await Promise.all([
    db.select().from(hitlReasons),
    db.select().from(hitlResolutions),
    db.select().from(notificationTypes),
    db.select().from(workflowStepNames),
  ])
  return {
    hitlReasons:       new LookupRegistry(reasons       as any),
    hitlResolutions:   new LookupRegistry(resolutions   as any),
    notificationTypes: new LookupRegistry(notifTypes    as any),
    workflowStepNames: new LookupRegistry(stepNames     as any),
  }
}

let _registries: HrRegistries | null = null

export async function getHrRegistries(): Promise<HrRegistries> {
  if (!_registries) _registries = await loadHrRegistries()
  return _registries
}
