-- Slice 56G: restore the classifier confidence threshold to a meaningful
-- value now that the corpus has ≥15 examples/class + an out_of_scope
-- rejection class.
--
-- We dropped lg.classifier_uncertain_threshold to 0.20 in the early
-- demo because the v1 model's max confidences were 0.27–0.36 (51 rows
-- across 7 classes). After 56G:
--   - corpus is now 121 rows across 8 classes (15+ each, plus 31 OOS)
--   - max confidences will rise materially (each class has stable boundaries)
--   - the 'out_of_scope' class catches off-topic inputs explicitly,
--     instead of forcing them into a tool intent
--
-- 0.55 is the post-56G default. Operators can tune per-tenant if needed.
-- Below 0.55 the classifier returns 'fallthrough' so the bot's planner
-- (or triage) gets to make the call instead.

UPDATE bot_tunables
   SET value_json = '0.55',
       notes = 'Slice 56G: restored to 0.55 after corpus growth + out_of_scope class. ' ||
               'Was 0.20 during the small-corpus demo phase. Lower for larger corpora; raise to be more conservative about routing.'
 WHERE key = 'lg.classifier_uncertain_threshold';
