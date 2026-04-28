# CIP Platform — Cross-Slice Notes

> Log issues discovered during a slice session that require a fix in an earlier slice.
> Resolve using `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` before starting the next slice.

---

## Template

```
### CS-NNN
- **Logged in:** Slice NN (name)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN
- **Issue:** One sentence.
- **Why it matters:** Which downstream slices or runtime behaviours break.
- **Fix:** Exact change required.
```

---

## Open Notes

_(no open notes)_

---

## Resolved Notes

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

### Known Deferred (pre-existing, requires architectural decision)

**CS-018** — Channel registry is process-local; all registrations lost on pod restart.
Affects `packages/teams-bot/src/teams-protocol/channel-registry.ts`.
Resolution: Redis / NATS KV / PostgreSQL — decide before production launch.
