// Canonical IntentResultSchema lives in @cip/shared utils/zod-schemas — re-export it here
// so the rest of teams-bot has a single local import point.
export { IntentResultSchema } from '@cip/shared/src/utils/zod-schemas.js';
export type { IntentResult } from '@cip/shared/src/types/agent.js';
