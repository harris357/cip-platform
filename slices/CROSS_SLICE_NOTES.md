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

### CS-018
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 17 (Teams Bot Core)
- **File:** `packages/teams-bot/src/teams-protocol/channel-registry.ts`
- **Status:** RESOLVED — 2026-04-27 (Slice 26)
- **Issue:** The channel registry stored conversation references in a process-local in-memory Map with a 24-hour TTL; all registered channels were lost on pod restart.
- **Resolution:** Replaced in-memory Map with NATS JetStream KV bucket `teams-channel-registry` (TTL 24h, history 1). Bucket created idempotently by `scripts/bootstrap.sh`. `CHANNEL_REGISTRY_BUCKET` env var exposed in helm values. `registerChannel` and `getChannelRef` are now async; `server.ts` updated to `await getChannelRef`.

---

## Resolved Notes

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

### Known Deferred (pre-existing, requires architectural decision)


