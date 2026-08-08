Findings from broad audit:

High-confidence bugs to fix first:
1. `src/mention-handler.js` latency bug
   - `Date.now() - Date.now()` path reports `0ms` on errors.
   - Also prior review noted `totalStart` scope issue in catch path. Need one clean timing source above try/finally.

2. `src/utils/rate-limit.js` cleanup bug
   - `cleanupRateLimits()` clears `activeTokens` and `activeGlobalRequests` during normal cleanup.
   - This can invalidate in-flight requests and break limiter state.

3. `src/actions/moderation.js` / `src/utils/warnings.js` signature mismatch
   - Warning data is being passed as object in one path and string in another.
   - Risk: stored warning reason becomes `[object Object]`.
   - Need one canonical call shape and update all callers.

4. `src/prefix-handler.js` `!chat` history size bug
   - Uses full history, unlike mention path.
   - Can overflow context and cause garbage/error.
   - Needs same bounded slice as mention flow.

5. `src/actions/moderation.js` channel-delete schema mismatch
   - `execDeleteChannel` expects `channel_name` but route schema has `channel_id`/`name`.
   - Delete path can fail.

6. `src/utils/memory.js` context trigger too broad
   - `needsContext` still matches common words like `yang` / `itu`.
   - That defeats optimization and causes near-always summary/context injection.

7. `src/ai/router.js` dead config values / cooldown mismatch
   - Hardcoded quota/rate cooldowns ignore `config.aiQuotaCooldownMs` and `config.aiRateLimitCooldownMs`.
   - Use config values.

8. `src/mention-handler.js` and related duplicated action helpers
   - `ping/weather/invite` duplication between mention and prefix handlers.
   - Not urgent bug, but easy consolidation if you want cleanup.

What I’d change:
- Fix 1–6 as real bugs.
- Fix 7 as config correctness.
- Leave duplication cleanup for after bug pass unless you want full refactor.

Verification:
- Run syntax check / targeted offline tests after edits.
- If available, run existing offline security/reliability tests from `src/test-security.js` and `src/test-voice-features.js` if they cover touched paths.

Need your approval to start edits, or say "fix first 1-7" if you want only bug pass, not refactor cleanup.