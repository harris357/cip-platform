// Slice 58D-A — person_match_resolutions DB queries (drizzle).
//
// Helpers used by the persistPersonMatchResolutionActivity (insert/update
// the table as the workflow progresses) and by the admin MCP tools
// (match_person_list reads pending rows; match_person_resolve looks up
// the workflow_id by resolution_id to send the signal).
//
// All queries run inside withTenantRLS so the DB enforces tenant
// isolation; activities and tools must call them inside that wrapper.

import { eq, and, sql } from 'drizzle-orm';

import { getDb, type Db } from '../../../../db/index.js';
import { withTenantRLS } from '../../../../db/rls.js';
import { personMatchResolutions } from '../../../../db/schema.js';

export interface PersonMatchResolutionRow {
  id:                   string;
  tenantId:             string;
  workflowId:           string;
  callerSubmissionId:   string;
  initiatedAt:          Date;
  resolvedAt:           Date | null;
  source:               string;
  candidateText:        string;
  structuredHints:      unknown;
  contextMeta:          Record<string, unknown>;
  policy:               Record<string, unknown>;
  canonicalization:     unknown;
  shortlist:            unknown;
  scoredCandidates:     unknown;
  hitlOffered:          boolean;
  hitlOfferedAt:        Date | null;
  hitlAudience:         string | null;
  hitlActorEmployeeId:  string | null;
  hitlActorRole:        string | null;
  resolvedEmployeeId:   string | null;
  resolutionSource:     string | null;
  confidence:           number | null;
  outcome:              string;
  evidence:             unknown;
}

/** Initial-row insert. Called once at workflow entry, returns the new id. */
export async function insertResolutionInit(args: {
  tenantId:             string;
  workflowId:           string;
  callerSubmissionId:   string;
  source:               string;
  candidateText:        string;
  structuredHints:      unknown;
  contextMeta:          Record<string, unknown>;
  policy:               Record<string, unknown>;
}): Promise<{ resolutionId: string }> {
  const db = getDb();
  const inserted = await withTenantRLS(db, args.tenantId, (tx: Db) =>
    tx
      .insert(personMatchResolutions)
      .values({
        tenantId:           args.tenantId,
        workflowId:         args.workflowId,
        callerSubmissionId: args.callerSubmissionId,
        source:             args.source,
        candidateText:      args.candidateText,
        structuredHints:    args.structuredHints,
        contextMeta:        args.contextMeta,
        policy:             args.policy,
        outcome:            'pending',
      })
      .returning({ id: personMatchResolutions.id }),
  );
  const id = inserted[0]?.id;
  if (!id) throw new Error('insertResolutionInit: returning row missing id');
  return { resolutionId: id };
}

/** Mid-flight update: write the canonicalization / shortlist / scored
 *  output. Idempotent; no-op-safe on retry. */
export async function updateResolutionProcess(args: {
  tenantId:         string;
  resolutionId:     string;
  canonicalization?: unknown;
  shortlist?:        unknown;
  scoredCandidates?: unknown;
}): Promise<void> {
  const db = getDb();
  await withTenantRLS(db, args.tenantId, (tx: Db) =>
    tx
      .update(personMatchResolutions)
      .set({
        ...(args.canonicalization !== undefined && { canonicalization: args.canonicalization }),
        ...(args.shortlist        !== undefined && { shortlist:        args.shortlist        }),
        ...(args.scoredCandidates !== undefined && { scoredCandidates: args.scoredCandidates }),
      })
      .where(and(
        eq(personMatchResolutions.id,       args.resolutionId),
        eq(personMatchResolutions.tenantId, args.tenantId),
      )),
  );
}

/** Mark that a HITL pickcard has been offered. Sets `hitl_offered = true`
 *  + audience + offered_at. Idempotent; second offer (cascade) overwrites
 *  the audience while keeping `hitl_offered = true`. */
export async function updateResolutionHitlOffered(args: {
  tenantId:     string;
  resolutionId: string;
  audience:     'uploader' | 'admin';
}): Promise<void> {
  const db = getDb();
  await withTenantRLS(db, args.tenantId, (tx: Db) =>
    tx
      .update(personMatchResolutions)
      .set({
        hitlOffered:    true,
        hitlOfferedAt:  new Date(),
        hitlAudience:   args.audience,
      })
      .where(and(
        eq(personMatchResolutions.id,       args.resolutionId),
        eq(personMatchResolutions.tenantId, args.tenantId),
      )),
  );
}

/** Final write: set outcome + resolved_at + outcome details. */
export async function updateResolutionFinal(args: {
  tenantId:           string;
  resolutionId:       string;
  outcome:            'resolved' | 'no_resolution' | 'cancelled';
  resolvedEmployeeId?: string;
  resolutionSource?:   string;
  confidence?:         number;
  hitlActorEmployeeId?: string;
  hitlActorRole?:      'uploader' | 'admin';
  evidence:            Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await withTenantRLS(db, args.tenantId, (tx: Db) =>
    tx
      .update(personMatchResolutions)
      .set({
        outcome:    args.outcome,
        resolvedAt: new Date(),
        ...(args.resolvedEmployeeId  !== undefined && { resolvedEmployeeId:  args.resolvedEmployeeId  }),
        ...(args.resolutionSource    !== undefined && { resolutionSource:    args.resolutionSource    }),
        ...(args.confidence          !== undefined && { confidence:          args.confidence          }),
        ...(args.hitlActorEmployeeId !== undefined && { hitlActorEmployeeId: args.hitlActorEmployeeId }),
        ...(args.hitlActorRole       !== undefined && { hitlActorRole:       args.hitlActorRole       }),
        evidence: args.evidence,
      })
      .where(and(
        eq(personMatchResolutions.id,       args.resolutionId),
        eq(personMatchResolutions.tenantId, args.tenantId),
      )),
  );
}

/** Fetch a single resolution by id. Used by the bot invoke handler to
 *  read context_meta + hitl_audience for the click-auth check, and by
 *  match_person_resolve to find the workflow_id. */
export async function findResolutionById(args: {
  tenantId:     string;
  resolutionId: string;
}): Promise<PersonMatchResolutionRow | null> {
  const db = getDb();
  const rows = await withTenantRLS(db, args.tenantId, (tx: Db) =>
    tx
      .select()
      .from(personMatchResolutions)
      .where(and(
        eq(personMatchResolutions.id,       args.resolutionId),
        eq(personMatchResolutions.tenantId, args.tenantId),
      ))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  return row as unknown as PersonMatchResolutionRow;
}

/** Admin-queue listing. Default state filter is 'pending_admin' — rows
 *  that have either escalated to admin or were initiated with an
 *  admin-queue policy. 'pending_any' returns every pending row;
 *  'all' is unfiltered. */
export async function listPendingResolutions(args: {
  tenantId: string;
  state:    'pending_admin' | 'pending_any' | 'all';
  limit:    number;
}): Promise<PersonMatchResolutionRow[]> {
  const db = getDb();
  const rows = await withTenantRLS(db, args.tenantId, (tx: Db) => {
    const base = tx
      .select()
      .from(personMatchResolutions)
      .where(and(
        eq(personMatchResolutions.tenantId, args.tenantId),
        ...(args.state === 'all'
          ? []
          : [eq(personMatchResolutions.outcome, 'pending')]),
        ...(args.state === 'pending_admin'
          ? [eq(personMatchResolutions.hitlAudience, 'admin')]
          : []),
      ))
      .orderBy(sql`initiated_at DESC`)
      .limit(args.limit);
    return base;
  });
  return rows as unknown as PersonMatchResolutionRow[];
}
