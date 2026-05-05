import { describe, it, expect } from 'vitest'
import { canRead, type PolicyDoc } from '../src/lifecycle/access-policy.js'
import type { ActorContext } from '../src/db/rls.js'

const TENANT = '00000000-0000-0000-0000-00000000aaaa'
const UPLOADER = '00000000-0000-0000-0000-000000001111'
const SUBJECT  = '00000000-0000-0000-0000-000000002222'
const STRANGER = '00000000-0000-0000-0000-000000003333'

const baseDoc = (over: Partial<PolicyDoc>): PolicyDoc => ({
  uploaderEmployeeId: UPLOADER,
  subjectEmployeeId: null,
  module: null,
  lifecycleState: 'quarantined',
  ...over,
})

const baseActor = (over: Partial<ActorContext>): ActorContext => ({
  tenantId: TENANT,
  employeeId: STRANGER,
  actorRole: 'reader',
  hasDocumentsAdminRead: false,
  hasDocumentsAdminUnpurge: false,
  hasDocumentsAuditRead: false,
  modulePermissionsByModule: {},
  ...over,
})

describe('access-policy.canRead', () => {
  it('system actor sees everything regardless of state', () => {
    const sys = baseActor({ actorRole: 'system' })
    for (const state of ['quarantined','scanning','classifying','routed','archived','soft_purged','hard_purged','failed'] as const) {
      const doc = baseDoc({ lifecycleState: state })
      const r = canRead(sys, doc)
      expect(r.allowed, `state ${state}`).toBe(true)
    }
  })

  it('uploader sees own doc in non-purged states; CANNOT see purged states', () => {
    const uploader = baseActor({ employeeId: UPLOADER })
    expect(canRead(uploader, baseDoc({ lifecycleState: 'quarantined' })).allowed).toBe(true)
    expect(canRead(uploader, baseDoc({ lifecycleState: 'scanning' })).allowed).toBe(true)
    expect(canRead(uploader, baseDoc({ lifecycleState: 'archived' })).allowed).toBe(true)
    // Soft-purge administratively hides the doc from the uploader too — admin
    // unpurge is the path back.  This matches the slice 58A access matrix.
    expect(canRead(uploader, baseDoc({ lifecycleState: 'soft_purged' })).allowed).toBe(false)
    expect(canRead(uploader, baseDoc({ lifecycleState: 'hard_purged' })).allowed).toBe(false)
  })

  it('stranger CANNOT read pre-classified doc', () => {
    const stranger = baseActor({ employeeId: STRANGER })
    expect(canRead(stranger, baseDoc({ lifecycleState: 'quarantined' })).allowed).toBe(false)
    expect(canRead(stranger, baseDoc({ lifecycleState: 'classifying' })).allowed).toBe(false)
  })

  it('documents.admin.read sees pre-classified docs', () => {
    const admin = baseActor({ employeeId: STRANGER, hasDocumentsAdminRead: true })
    expect(canRead(admin, baseDoc({ lifecycleState: 'quarantined' })).allowed).toBe(true)
    expect(canRead(admin, baseDoc({ lifecycleState: 'hitl_admin_queue' })).allowed).toBe(true)
    expect(canRead(admin, baseDoc({ lifecycleState: 'reclassification_requested' })).allowed).toBe(true)
    expect(canRead(admin, baseDoc({ lifecycleState: 'scan_failed' })).allowed).toBe(true)
    expect(canRead(admin, baseDoc({ lifecycleState: 'failed' })).allowed).toBe(true)
  })

  it('documents.admin.read CANNOT read soft-purged (needs admin.unpurge)', () => {
    const admin = baseActor({ employeeId: STRANGER, hasDocumentsAdminRead: true, hasDocumentsAdminUnpurge: false })
    expect(canRead(admin, baseDoc({ lifecycleState: 'soft_purged' })).allowed).toBe(false)
  })

  it('documents.admin.unpurge sees soft-purged', () => {
    const admin = baseActor({ employeeId: STRANGER, hasDocumentsAdminUnpurge: true })
    expect(canRead(admin, baseDoc({ lifecycleState: 'soft_purged' })).allowed).toBe(true)
  })

  it('subject sees own routed/archived doc', () => {
    const subjectActor = baseActor({ employeeId: SUBJECT })
    const routedDoc = baseDoc({ lifecycleState: 'routed', subjectEmployeeId: SUBJECT, module: 'certificate' })
    expect(canRead(subjectActor, routedDoc).allowed).toBe(true)
    const archivedDoc = baseDoc({ lifecycleState: 'archived', subjectEmployeeId: SUBJECT, module: 'certificate' })
    expect(canRead(subjectActor, archivedDoc).allowed).toBe(true)
  })

  it('module-permitted reader sees archived doc by module', () => {
    const certReader = baseActor({ employeeId: STRANGER, modulePermissionsByModule: { certificate: true } })
    const doc = baseDoc({ lifecycleState: 'archived', module: 'certificate', subjectEmployeeId: SUBJECT })
    expect(canRead(certReader, doc).allowed).toBe(true)
  })

  it('module reader for module X cannot read archived module Y doc', () => {
    const certReader = baseActor({ employeeId: STRANGER, modulePermissionsByModule: { certificate: true } })
    const doc = baseDoc({ lifecycleState: 'archived', module: 'training' })
    expect(canRead(certReader, doc).allowed).toBe(false)
  })

  it('hard-purged is unreadable to everyone except system', () => {
    expect(canRead(baseActor({ employeeId: UPLOADER }), baseDoc({ lifecycleState: 'hard_purged' })).allowed).toBe(false)
    expect(canRead(baseActor({ hasDocumentsAdminRead: true }), baseDoc({ lifecycleState: 'hard_purged' })).allowed).toBe(false)
    expect(canRead(baseActor({ actorRole: 'system' }), baseDoc({ lifecycleState: 'hard_purged' })).allowed).toBe(true)
  })

  it('reasons are stable + descriptive', () => {
    expect(canRead(baseActor({ actorRole: 'system' }), baseDoc({})).reason).toBe('system')
    expect(canRead(baseActor({ employeeId: UPLOADER }), baseDoc({})).reason).toBe('uploader_own')
  })
})
