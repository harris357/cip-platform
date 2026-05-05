// Slice 58B — sensitivity tier composition.
//
// Final tier = max(L1, L2, L3, tenant_floor). Ordering is:
//   public < internal < confidential < restricted

import type { SensitivityTier } from '@cip/shared'

export const TIER_RANK: Record<SensitivityTier, number> = {
  public:        0,
  internal:      1,
  confidential:  2,
  restricted:    3,
}

const REVERSE_RANK = ['public', 'internal', 'confidential', 'restricted'] as const

/** Pick the higher-sensitivity tier across an arbitrary set of inputs. */
export function maxTier(...tiers: ReadonlyArray<SensitivityTier | undefined>): SensitivityTier {
  let best = 0
  for (const t of tiers) {
    if (t === undefined) continue
    const r = TIER_RANK[t]
    if (r > best) best = r
  }
  return REVERSE_RANK[best] ?? 'public'
}
