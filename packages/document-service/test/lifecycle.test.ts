import { describe, it, expect } from 'vitest'
import {
  LIFECYCLE_STATES, VALID_TRANSITIONS, canTransition, assertCanTransition,
  ACTIVE_PHASES, TERMINAL_PHASES,
} from '../src/lifecycle/states.js'

describe('lifecycle states', () => {
  it('transition map is exhaustive — every state has an entry', () => {
    for (const s of LIFECYCLE_STATES) {
      expect(VALID_TRANSITIONS[s]).toBeDefined()
    }
  })

  it('every transition target is itself a valid state', () => {
    for (const [, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const t of targets) {
        expect(LIFECYCLE_STATES).toContain(t)
      }
    }
  })

  it('terminal phases have no forward transitions (or only soft_purged)', () => {
    expect(VALID_TRANSITIONS.hard_purged).toEqual([])
    // archived can still go to reclassification_requested or soft_purged
    expect(VALID_TRANSITIONS.archived).toContain('soft_purged')
  })

  it('canTransition returns true for valid + false for invalid', () => {
    expect(canTransition('quarantined', 'scanning')).toBe(true)
    expect(canTransition('quarantined', 'archived')).toBe(false) // can't skip phases
    expect(canTransition('hard_purged', 'soft_purged')).toBe(false) // hard_purged is terminal
  })

  it('assertCanTransition throws on illegal transitions', () => {
    expect(() => assertCanTransition('quarantined', 'archived')).toThrow(/illegal/)
    expect(() => assertCanTransition('classifying', 'awaiting_subject')).not.toThrow()
  })

  it('ACTIVE_PHASES + TERMINAL_PHASES + soft_purged + scan_failed cover everything', () => {
    const covered = new Set<string>()
    ACTIVE_PHASES.forEach((s) => covered.add(s))
    TERMINAL_PHASES.forEach((s) => covered.add(s))
    covered.add('soft_purged')
    covered.add('scan_failed')
    for (const s of LIFECYCLE_STATES) {
      expect(covered.has(s)).toBe(true)
    }
  })
})
