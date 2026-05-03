// Slice 55: types for the per-tool argument extraction framework.
//
// An Extractor takes a raw user message + auth context + DB pool and
// returns one of:
//   - complete   — args are filled, execute the tool directly
//   - ambiguous  — DB resolution returned >1 match → render disambiguation card
//   - missing    — required args couldn't be extracted → templated clarify
//   - no_match   — extractor didn't recognize anything → fall through to planner
//
// Each tool that the grammar router can route to declares its own
// extractor in packages/teams-bot/src/intent/extractors/<tool>.ts.

import type pg from 'pg';
import type { BotAuthContext } from '../../auth/resolve-context.js';

export interface ExtractionDeps {
  pool: pg.Pool;
}

export interface DisambiguationCandidate {
  id:    string;
  label: string;
  hint?: string;
}

export type ExtractionResult =
  | { kind: 'complete';   args: Record<string, unknown> }
  | { kind: 'ambiguous';  argName: string; candidates: DisambiguationCandidate[] }
  | { kind: 'missing';    missing: string[] }
  | { kind: 'no_match' };

export interface Extractor {
  toolName: string;
  extract: (
    text: string,
    ctx:  BotAuthContext,
    deps: ExtractionDeps,
  ) => Promise<ExtractionResult>;
}
