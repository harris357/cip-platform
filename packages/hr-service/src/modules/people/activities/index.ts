// Slice 58D-A — people-module activity barrel.
//
// Worker registers these via `import * as peopleActivities` + spread.
// Workflow imports type * for proxyActivities<typeof activities>.

export { loadPeopleTunablesActivity } from './load-people-tunables.activity.js';
export type { LoadPeopleTunablesInput, PeopleTunables } from './load-people-tunables.activity.js';
export { PeopleTunablesSchema } from './load-people-tunables.activity.js';

export { aadPrecheckActivity } from './aad-precheck.activity.js';
export type { AadPrecheckInput, AadPrecheckOutput } from './aad-precheck.activity.js';

export { canonicalizePersonHintActivity } from './canonicalize-person-hint.activity.js';
export type { CanonicalizePersonHintInput, Canonicalization } from './canonicalize-person-hint.activity.js';
export { CanonicalizationSchema } from './canonicalize-person-hint.activity.js';

export { loadEmployeeShortlistActivity } from './load-employee-shortlist.activity.js';
export type { LoadEmployeeShortlistInput } from './load-employee-shortlist.activity.js';

export { scoreCandidatesActivity } from './score-candidates.activity.js';
export type { ScoreCandidatesInput } from './score-candidates.activity.js';

export { notifyPersonPickcardActivity } from './notify-person-pickcard.activity.js';
export type { NotifyPersonPickcardInput } from './notify-person-pickcard.activity.js';

export { persistPersonMatchResolutionActivity } from './persist-person-match-resolution.activity.js';
export type {
  PersistPersonMatchResolutionInput,
  PersistPersonMatchResolutionOutput,
} from './persist-person-match-resolution.activity.js';
