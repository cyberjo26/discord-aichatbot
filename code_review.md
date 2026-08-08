# 🔍 Full Codebase Review — Discord AI Chatbot

Solid project. Architecture clean, modularization good, provider fallback chain smart. Below findings only.

---

## 🔴 Bugs — Will Break

`mention-handler.js:L213`: `totalStart` referenced in `catch` but declared inside `try` at L141. If error thrown before L141 (e.g. at L76-81 rate-limit or L84 dedup), `totalStart` is `undefined` → `Date.now() - undefined` = `NaN` latency recorded.
**Fix:** Move `const totalStart = Date.now()` above the `try` block (after L74), or default `totalStart` at declaration.

`warnings.js:L34` vs `moderation.js:L328`: **Signature mismatch.** `addWarning(guildId, userId, reason, warnedBy)` expects `reason` as a string. But `moderation.js:L328` calls `addWarning(guild.id, member.id, { reason, warnerId })` — passes an **object**. Result: warning saved with `reason: "[object Object]"`. `index.js:L225` calls correctly with `(guildId, userId, stringReason, botId)`.
**Fix:** Pick one signature. Either `moderation.js` should call `addWarning(guild.id, member.id, reason, message.author.id)`, or `warnings.js` should destructure the object param.

`prefix-handler.js:L197-200`: `!chat` sends full `history` with no `.slice()`. If user has 30 messages (max), system prompt + 30 messages + new message = 32 messages. For routing model with 220 max_tokens, this can exceed input context → provider returns error or truncated garbage.
**Fix:** Apply `.slice(-6)` like [mention-handler.js:L784](file:///d:/testprojek/discord-aichatbot-main/src/mention-handler.js#L784) does.

---

## 🟡 Risks — Works but Fragile

`index.js:L183`: Storing the full `message` Discord.js object inside `userMessageHistory`. These are heavy objects with guild, channel, member references. On busy servers with spam attempts, this holds 100s of full message objects in memory during the 4-second window.
**Fix:** Store only `{ messageId, channelId, content: message.content, timestamp }` — drop the `message` ref. Reconstruct deletion via `channel.messages.delete(id)`.

`router.js:L44-47`: Round-robin rotation uses `requestCount % configured.length`. `requestCount` is a plain `let` — monotonically grows forever. After 2^53 requests (~285 trillion, unrealistic but still) it loses precision.
**Fix:** Reset `requestCount` modulo something large, or just `requestCount = (requestCount + 1) % 1000000`.

`router.js:L74-83`: `recordFailure` — circuit breaker cooldowns for `QUOTA_EXHAUSTED` (30min) and `RATE_LIMITED` (2min) are hardcoded, ignoring `config.aiQuotaCooldownMs` and `config.aiRateLimitCooldownMs` that were added to config. Config is dead code.
**Fix:** Use `config.aiQuotaCooldownMs` and `config.aiRateLimitCooldownMs`.

`voicemaster.js:L149-153`: `saveTempChannels` filter is a no-op — `return true` for every ID. If bot is in multiple guilds, **all guilds' temp channel IDs get saved to every guild's settings**.
**Fix:** Pass `guildId` and filter: `const guild = client.guilds.cache.get(guildId); return guild?.channels.cache.has(id);` Or restructure to track per-guild from the start.

`mention-handler.js:L167`: Response truncation at 1900 chars. But if message contains multi-byte UTF-8 (Indonesian diacritics, emoji), `.slice(0, 1900)` can cut mid-codepoint. Discord might reject the message.
**Fix:** Use a safe truncation that doesn't split surrogate pairs: find last complete char boundary.

`discord-helpers.js:L39`: `await guild.members.fetch()` fetches **ALL** members on every name-based lookup. On a 10k+ member server this is heavy and rate-limited by Discord.
**Fix:** Use `guild.members.fetch({ query: targetName, limit: 10 })` for partial matches instead.

`learned-patterns.js:L319`: Pattern ID uses `patterns.length + 1`. After deletions (L331-334 removes least-used), IDs will collide with existing patterns. Not functionally breaking since IDs aren't used as keys, but messy.
**Fix:** Use a counter that only increments, or use `crypto.randomUUID()`.

`prefix-handler.js:L465-471` + `mention-handler.js:L876-881`: Voice playback fire-and-forget with `setTimeout`. If bot crashes during playback, voice connection leaks. The `player.js` has a 60s safety timeout (L123), but `setTimeout` at L465 in prefix-handler means the error is swallowed with only a log.
**Fix:** Acceptable as-is, but consider returning the Promise for proper error tracking.

`memory.js:L231`: `setInterval(cleanup, 10 * 60 * 1000)` — no `.unref()`. This keeps the process alive even after `client.destroy()` in shutdown. Same issue in `rate-limit.js` (no cleanup interval though, called manually).
**Fix:** Add `.unref()` or clear interval on shutdown.

---

## 🔵 Nits — Style / Optimization

### Code Duplication

`mention-handler.js:L461-486` ↔ `prefix-handler.js:L826-850`: `execPing` / `handlePing` — **identical logic**, duplicated. Both fetch Google HEAD, build same embed.
**Fix:** Extract to `src/actions/utility.js` and import from both handlers.

`mention-handler.js:L488-518` ↔ `prefix-handler.js:L852-884`: `execWeather` / `handleWeather` — **identical logic** duplicated.
**Fix:** Same — extract to shared action.

`mention-handler.js:L520-538` ↔ `prefix-handler.js:L886-903`: `execInvite` / `handleInvite` — **identical logic** duplicated.
**Fix:** Same — extract to shared action.

`prefix-handler.js:L592-633` ↔ `moderation.js:L309-343`: Warning logic duplicated. `prefix-handler` has its own `handleWarn` with different thresholds (3/5 warnings → timeout) vs `moderation.js` `execWarn` (2/3 warnings → timeout/kick). **Inconsistent escalation policy.**
**Fix:** Consolidate into one `execWarn` in `moderation.js`, use from both handlers.

`prefix-handler.js:L487-522` `resolveMemberFromArgs` ↔ `discord-helpers.js:L23-83` `resolveTargetMember`: Two different member resolution strategies. Prefix handler resolves by position (first arg = target), mention handler resolves by AI-parsed `target_id`/`target_name`.
**Fix:** Acceptable for now (different input formats), but document the distinction.

### Token Optimization

`prompts.js:L8`: `SECRET_BEHAVIOR` is injected into 3 separate prompts — routing (L108), Jarvis (L173), and `buildSystemPrompt` (L26). Routing prompt doesn't need personality — it just classifies actions.
**Fix:** Remove `SECRET_BEHAVIOR` from routing prompt to save ~30 tokens per routing call.

`prompts.js:L100-146`: `buildAgentReasoningPrompt` is defined but never called anywhere in the codebase. Dead code.
**Fix:** Remove it, or replace `buildAgentRoutingPrompt` if reasoning was intended for complex cases.

`memory.js:L88-99`: Context summary generation fires an AI call every 5 messages. That's an extra API call (with 150 max_tokens) even for casual "hi/bye" conversations.
**Fix:** Only generate summary if at least 2 user messages contain substantive content (>20 chars).

### Structural

`mention-handler.js`: 885 lines. Still the largest file by far despite action extraction. The `execPing`, `execWeather`, `execInvite`, `execAnnounceAsk`, `formatActionResult`, `generateNaturalResponse`, `sendWithArticleButton`, `handleUpdateLearn`, `playVoiceIfInChannel` could all be extracted.
**Fix:** Move `execPing/Weather/Invite` → `actions/utility.js`. Move `formatActionResult` → `utils/formatter.js`. Move `generateNaturalResponse` → `ai/response-generator.js`.

`prefix-handler.js`: 904 lines. Same issue — moderation commands (`handleWarn`, `handleBungkam`, `handleKick`, `handleDc`, `handleTo`, `handlePrune`, `handleCn`) duplicate logic that exists in `actions/moderation.js`.
**Fix:** Reuse `execTimeout`, `execBanKick`, etc. from `actions/moderation.js` with adapter functions.

`config.js:L101`: `ownerId` fallback is `null` but `prompts.js:L101,L168` falls back to hardcoded `'407516822284402690'`. If `OWNER_ID` env var is unset, the bot still references a specific Discord user ID in prompts.
**Fix:** Remove hardcoded fallback in prompts. Use `config.ownerId || 'the creator'`.

### Minor

`scraper.js:L63-76`: Indentation inconsistency — lines 63-95 are indented 4 spaces while inside a `try` block that uses 6 spaces above.
**Fix:** Re-indent to consistent level.

`rag/pipeline.js:L21-33`: `normalizeQuery` applies framework-specific replacements (`nodejs`, `reactjs`, etc.). These are hardcoded heuristics that won't scale.
**Fix:** Acceptable for now; consider moving to a config-driven alias map if more get added.

`actions/moderation.js:L332-338`: Auto-escalation at 2 warnings → timeout, 3 warnings → kick. But `prefix-handler.js:L616-630` uses 3 warnings → timeout, 5 warnings → longer timeout (no kick). Two different punishment ladders.
**Fix:** Consolidate escalation policy into a single function in `warnings.js`.

`rate-limit.js:L55`: Token generation uses `Math.random()` — not cryptographically secure. Fine for rate-limit tokens (not security-sensitive), but if ever used for auth, this is a vuln.
**Fix:** `🔵 nit:` Acceptable as-is. Note for future.

`voice/welcome.js:L134`: Welcome text is hardcoded in Indonesian. No config for message template.
**Fix:** Add `VOICE_WELCOME_TEMPLATE` to config or use AI-generated greeting like text welcome does.

---

## Summary Table

| Severity | Count | Files Affected |
|----------|-------|----------------|
| 🔴 Bug | 3 | mention-handler, warnings/moderation, prefix-handler |
| 🟡 Risk | 8 | index, router, voicemaster, discord-helpers, learned-patterns, memory |
| 🔵 Nit | 12+ | mention-handler, prefix-handler, prompts, config, scraper, pipeline |
| 📦 Duplication | 5 areas | ping/weather/invite/warn/member-resolve across handlers |

### Priority Actions
1. **Fix `warnings.js` ↔ `moderation.js` signature mismatch** — warnings being saved as `"[object Object]"` right now
2. **Fix `totalStart` undefined in catch block** — NaN metrics on early errors
3. **Fix `!chat` unbounded history** — can blow provider context window
4. **Use config cooldowns in `router.js`** — dead config vars
5. **Extract duplicated ping/weather/invite** — easy win for maintainability
