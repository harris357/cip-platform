// Slice 41: fallback prompt registry. Loaded at module init by langfuse.ts
// to pre-compile Jinja2 templates. New prompts get registered here.

import { BOT_TRIAGE }            from './bot-triage.js';
import { BOT_PLAN }              from './bot-plan.js';
import { BOT_SUMMARIZE }         from './bot-summarize.js';
import { HR_VISION_EXTRACT }     from './hr-vision-extract.js';
import { HR_EMPLOYEE_MATCH }     from './hr-employee-match.js';
import { HR_CERT_DEF_MATCH }     from './hr-cert-def-match.js';

// Slice 47b: bot.intent_classify and bot.meta_compose removed — legacy
// classifier+router pipeline was deleted. The Langfuse prompts may
// still exist in the production label, but the bot no longer fetches
// them. Safe to delete from Langfuse during a future cleanup.

export const FALLBACKS: Record<string, string> = {
  'bot.triage':                BOT_TRIAGE,
  'bot.plan':                  BOT_PLAN,
  'bot.summarize':             BOT_SUMMARIZE,
  'hr-service.vision_extract': HR_VISION_EXTRACT,
  'hr-service.employee_match': HR_EMPLOYEE_MATCH,
  'hr-service.cert_def_match': HR_CERT_DEF_MATCH,
};
