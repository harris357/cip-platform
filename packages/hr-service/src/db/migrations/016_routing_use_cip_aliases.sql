-- Slice 43/44 follow-up: align routing_rules with the LiteLLM gateway's
-- registered CIP aliases. Migrations 014 and 015 used raw Mistral model
-- names ("mistral-small-latest", "open-mistral-nemo", "mistral-embed"),
-- but LiteLLM's model_list only registers CIP-named aliases (cip-*).
-- A raw Mistral name produces "Invalid model name passed in" 400s.
--
-- Fix: point each purpose at the existing CIP alias whose underlying
-- model matches what we actually want.
--
--   bot.route        → cip-router-careful (mistral/mistral-small-latest)
--   bot.meta_compose → cip-classifier     (mistral/open-mistral-nemo)
--   bot.embed        → cip-embed          (mistral/mistral-embed) — NEW alias,
--                                         added in the LiteLLM config alongside
--                                         this migration.

UPDATE routing_rules
   SET alias = 'cip-router-careful',
       notes = 'Function calling over the full permitted catalog (Slice 43). Underlying model: mistral-small-latest.',
       updated_at = NOW(),
       updated_by = 'migration-016'
 WHERE service = 'bot' AND purpose = 'route';

UPDATE routing_rules
   SET alias = 'cip-classifier',
       notes = 'Composes the meta reply from the user''s permitted tools (Slice 43). Reuses the cip-classifier alias — same nemo model, same cost profile.',
       updated_at = NOW(),
       updated_by = 'migration-016'
 WHERE service = 'bot' AND purpose = 'meta_compose';

UPDATE routing_rules
   SET alias = 'cip-embed',
       notes = 'Embeds user messages + tool descriptions for top-K vector retrieval (Slice 44). Underlying model: mistral-embed (1024-dim). New alias registered in LiteLLM config alongside this migration.',
       updated_at = NOW(),
       updated_by = 'migration-016'
 WHERE service = 'bot' AND purpose = 'embed';
