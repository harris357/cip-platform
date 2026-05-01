// Slice 41: fallback prompt registry. Loaded at module init by langfuse.ts
// to pre-compile Jinja2 templates. New prompts get registered here.

import { BOT_INTENT_CLASSIFY }   from './bot-intent-classify.js';
import { BOT_META_COMPOSE }      from './bot-meta-compose.js';
import { BOT_TRIAGE }            from './bot-triage.js';
import { BOT_PLAN }              from './bot-plan.js';
import { HR_VISION_EXTRACT }     from './hr-vision-extract.js';
import { HR_EMPLOYEE_MATCH }     from './hr-employee-match.js';
import { HR_CERT_DEF_MATCH }     from './hr-cert-def-match.js';

export const FALLBACKS: Record<string, string> = {
  'bot.intent_classify':       BOT_INTENT_CLASSIFY,
  'bot.meta_compose':          BOT_META_COMPOSE,
  'bot.triage':                BOT_TRIAGE,
  'bot.plan':                  BOT_PLAN,
  'hr-service.vision_extract': HR_VISION_EXTRACT,
  'hr-service.employee_match': HR_EMPLOYEE_MATCH,
  'hr-service.cert_def_match': HR_CERT_DEF_MATCH,
};
