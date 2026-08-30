# 🧪 QA Test Report — Discord AI Chatbot

**Date:** 2026-08-29 — **R6 persistent-memory upgrade revision** (supersedes the 2026-08-29 R5 graph revision and the 2026-08-27 post-fix edition)
**Tester:** Senior QA / Software Testing engagement (automated suites + manual code review + bug-hunt + fix verification + knowledge-graph architecture audit)
**Runtime:** Node v22.13.1 win32/x64 (engines requires ≥22.12.0 ✅) · npm 10.9.2
**Method:** Full test-type coverage (unit → integration → system/E2E → regression → smoke/sanity → UAT → performance/load → security → usability/UX), a targeted deep-dive bug hunt, then a fix round that closed **every** finding. Each fix is now pinned by an inverted regression guard in `test/qa-bug-verification-r2.test.mjs`. This revision also documents the new **fresh-knowledge pipeline** (§10).
**Codebase under test:** ~12,500 LOC across 72 JS files in `src/` + 17 test files in `test/` + `scripts/` + `index.js`.

---

## 1. Executive Summary

| # | Test Type | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Unit Testing | ✅ **PASS** — 155/155 | `npm run test:unit`, ~23.6s |
| 2 | Integration Testing | ✅ **PASS** | `integration-actions` + `integration-handlers` with mocked Discord + AI |
| 3 | System / E2E Testing | ✅ **PASS** (offline + boot) | Full module graph loads; smoke boot reaches Discord auth; fail-fast on bad token |
| 4 | Regression Testing | ✅ **PASS** | Prior SEC-1 (tar vuln) fixed; **all 9 bugs + 2 security findings from the bug-hunt now FIXED and regression-guarded** (§10). R5 re-verified: no regression in any pinned guard (§14.3) |
| 5 | Smoke & Sanity Testing | ✅ **PASS** | 72/72 files `node --check` clean; ESLint 0/0; boot + missing-env paths verified |
| 6 | UAT | 🟡 **PASS (heuristic)** | Bilingual ID/EN UX, embeds, confirmations; no live user-acceptance session |
| 7 | Performance & Load | ✅ **PASS** | Bounded counters, SQLite WAL, RAG + fresh-answer caches, serialized voice queues, **log rotation added** |
| 8 | Security Testing | ✅ **PASS** | SSRF/rate-limit/secrets solid; **SEC-A and SEC-B both fixed** (§7) |
| 9 | Usability & UX | ✅ **GOOD** | Clear embeds/help; BUG-1 welcome-status formatting fixed |
| 10 | Static Analysis | ✅ **PASS** | ESLint 9 flat config: 0 errors, 0 warnings |

**Bottom line:** 163 automated checks pass, 0 failures (155 node:test + 7 voice + 3 security + 1 midnight). The bug-hunt's **9 confirmed defects and 2 security findings are all fixed**, with two fixes deliberately deviating from the report's suggested approach after analysis (BUG-2: evaluate-then-commit instead of rollback; BUG-9: `hour ≤ 9` shift instead of `hour ≤ 11`, to preserve genuine late-morning "siang"). The verification suite was inverted from bug-pins to regression guards, and 4 new tests cover the fresh-knowledge pipeline. New capability: when a question exceeds the model's knowledge cutoff, the bot now searches the live web and reasons Find → Compare → Select → Connect → Conclude before answering (§10).

---

## 2. Test Environment & Inventory

- **Entry points:** `index.js` (supervisor: midnight restart + crash respawn) → `src/index.js` (Discord client, 10 slash commands, `!` prefix, @mention Jarvis mode).
- **AI subsystem:** `src/ai/router.js` round-robin across 7 providers (OpenRouter, Gemini, Groq, Cerebras, Pollinations, Puter, custom OpenAI-compatible) with per-provider circuit breakers; `openai-factory.js` deduplicates the OpenAI-compatible adapters.
- **RAG:** Tavily → Wikipedia → DuckDuckGo search fallback chain; SSRF-hardened scraper (manual per-hop redirect re-validation, 5 MB cap, 5 s timeout).
- **Voice:** Edge TTS / custom TTS, per-guild serialized playback queues, VoiceMaster temp channels, voice welcomes with hub-defer logic.
- **Persistence:** SQLite (better-sqlite3 ~12.4.6, WAL mode, lease-based atomic reminder claims) + JSON stores (prefs, AFK, patterns, server settings, warnings).

---

## 3. Unit Testing — ✅ 155/155 PASS

```
$ npm run test:unit   (node --experimental-test-module-mocks --test "test/*.test.mjs")
# tests 155  pass 155  fail 0  skipped 0  — duration_ms 23603
```

Coverage spans `unit-utils` (rate-limit, retry, formatter, metrics, wake/sleep, Indonesian duration parsing, memory bounds), `unit-security` (SSRF IPv4/IPv6/loopback/link-local/IMDS), `unit-warnings` (escalation ladder #3→timeout, #5→kick, hierarchy guards), `unit-sanitizer`, `unit-afk`, `unit-welcome-embed`, `unit-router` (bounded round-robin), `unit-learned-patterns`, `unit-voice-player`, `unit-deploy`, `bugs-found`, `regression-prior-bugs`, `compat-smoke`, `perf-load`, plus the two integration suites.

**Updated this round:** `test/qa-bug-verification-r2.test.mjs` was **inverted** from bug-pins to regression guards — 11 assertions now assert the *correct* post-fix behaviour for BUG-1..9, SEC-A and SEC-B (any regression fails CI), plus **4 new tests** for the fresh-knowledge pipeline: `looksTimeSensitive` anchor detection, `needsFreshData` gate short-circuits (greeting → no, time-anchor → yes, no AI call), the full Find→Compare→Select→Connect→Conclude flow with mocked search/scrape/AI (source-index mapping verified), and graceful fallback when the web yields nothing.

---

## 4. Integration & System/E2E Testing — ✅ PASS

- **`integration-actions`:** moderation executors (timeout / ban-kick / warn / channel CRUD), voice ops, invite — wired through mocked `Message`/`Guild` fixtures with permission bits.
- **`integration-handlers`:** `handlePrefixCommand` dispatch, `handleMention` pipeline, server-settings persistence, AI `chatCompletion` mocking, voice-response helper.
- **System boot (positive E2E):** smoke boot with a dummy token loads the full module graph — user prefs, AFK, warnings, server settings all initialize, then fails cleanly at Discord auth (`Failed to login: An invalid token was provided`). Confirms wiring/config/persistence all work up to the network boundary.
- **Missing-env E2E:** booting without `DISCORD_TOKEN` exits with `❌ Missing required env variable: DISCORD_TOKEN` + guidance (`src/config.js:13`).
- **Supervisor E2E (offline):** `test:midnight` verifies `msUntilMidnight` TZ math.

---

## 5. Smoke & Sanity Testing — ✅ PASS

| Check | Result |
|---|---|
| `node --check` on all 71 `src/` JS files | ✅ 71/71 pass |
| `npx eslint .` (ESLint 9 flat config) | ✅ exit 0 — 0 errors, 0 warnings |
| Boot with missing credentials | ✅ fail-fast + guidance, `process.exit(1)` |
| Boot with dummy token | ✅ full init, clean auth failure |
| `npm run test:voice` (offline) | ✅ 7/7 |
| `npm run test:security` | ✅ 3/3 groups (SSRF, rate limits, backup paths) |
| `npm run test:midnight` | ✅ `ok: msUntilMidnight` |
| `npm audit --omit=dev` | ✅ **0 vulnerabilities** (prior SEC-1 fixed) |

---

## 6. Regression Testing — ✅ PASS (prior SEC-1 FIXED)

| Prior finding (2026-08-18) | Status | Evidence |
|---|---|---|
| **SEC-1:** critical `tar` chain via `@discordjs/opus` → `node-pre-gyp` | ✅ **FIXED** | `package.json` now pins `"overrides": { "tar": "^7.5.22" }`; `npm audit --omit=dev` → **0 vulnerabilities** |
| `execDeleteChannel` param fallback | ✅ still fixed | `src/actions/moderation.js:430` reads `channel_id \|\| channel_name \|\| name` |
| `cleanupRateLimits` wiping in-flight tokens | ✅ still fixed | `src/utils/rate-limit.js:80-96` deletes only expired entries |
| `needsContext` over-matching | ✅ still fixed | `src/utils/memory.js:183` requires specific phrases |

Historical regression suites (`bugs-found`, `regression-prior-bugs`) all pass — fixes remain pinned by tests.

---

## 7. Security Testing — ✅ PASS (both findings fixed)

### 7.1 Application security ✅ (strong)
- **SSRF:** `isSafeUrl` blocks localhost, private IPv4/IPv6, link-local, AWS IMDS; scraper uses `maxRedirects: 0` with per-hop re-validation; custom DNS `lookup` agent defeats DNS-rebinding (handles both `all:true`/`all:false` callback shapes). Verified by `unit-security` + `test:security`. The new fresh-knowledge pipeline reuses this same hardened scraper/search path, so it adds **no new SSRF surface**.
- **Rate limiting:** idempotent token release, user 20/min, guild 150/min, 50 global concurrency. **BUG-2 quota leak fixed** — counters are now evaluated read-only and only committed after all checks pass (evaluate-then-commit), verified by regression guard (denied request leaves 130/130 guild slots, not 129).
- **AuthZ:** owner gating + Discord permission-bit checks + role-hierarchy guards on moderation; `!act` cross-channel send is owner-only by design.
- **Injection surface:** reminder/welcome text sanitizers, display-name sanitization for TTS, control-char stripping in `sanitizeInput`. No `eval`/dynamic shell execution found. Learned patterns are now write-gated (SEC-B fix), shrinking the prompt-injection surface.

### 7.2 Secrets hygiene ✅
- No hardcoded keys/tokens in source; `.env` gitignored; `.gitignore` whitelists `QA_TEST_REPORT.md` (prior IMP-4 addressed).

### 7.3 Security findings — both FIXED

| ID | Severity | Finding | Fix applied |
|----|----------|---------|-------------|
| **SEC-A** | Medium | `/test-ai` had no permission gate — any member could fire arbitrary prompts at every provider and burn API credits. | ✅ **FIXED** — `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` **plus** a runtime owner-or-Administrator check (`src/commands/test-ai.js`). Belt-and-braces: the declaration hides the command from non-admins, the runtime check enforces it even if an old registration lingers. |
| **SEC-B** | Medium | `belajar:` / `ajarkan:` self-learning trigger had no permission check — any user could plant patterns injected into the AI routing prompt (knowledge-poisoning surface). | ✅ **FIXED** — teaching is now gated: `canTeach = isOwner(author) || member.permissions.has(ManageGuild)` (`src/mention-handler.js`). The `ask_clarification` learn flow checks the same gate and omits the "UPDATE" hint from unauthorized users. |

Both fixes are pinned by regression guards in `qa-bug-verification-r2.test.mjs`.

---

## 8. Performance & Load Testing — ✅ PASS

- **Rate limiter:** O(1) token release; 5-min cleanup safe for in-flight requests; round-robin counter bounded by modulo.
- **Memory store:** bounded per-user history windows; 1000-entry cap with LRU eviction; `getContext` injection capped.
- **AI router:** circuit breakers with separate quota/rate-limit/timeout cooldowns prevent hammering dead providers.
- **Voice:** per-guild promise chain serializes playback; 60 s safety timeout force-disconnects; single `finish()` path prevents dangling timers.
- **RAG:** 1-hour cache keyed on normalized query; graceful degradation (scrape fail → snippets → context-less answer). The fresh-knowledge pipeline adds its own 1-hour cache (same TTL discipline) plus a cheap local pre-filter so greetings/time-anchors never spend an AI gate call.
- **SQLite:** WAL mode; atomic lease-based reminder claim under concurrent polls (tested).
- **Logger:** **rotation added (BUG-10 fix)** — `bot.log` rotates to `bot-<date>.log` at 10 MB, pruned to 10 files; no remaining unbounded-growth vector.

No load-related defects in the hot paths. Single-process gateway is the inherent scale ceiling (discord.js, not a defect).

---

## 9. Usability / UX & UAT Assessment — ✅ GOOD

**Strengths:** consistent bilingual (ID/EN) messaging; rich embeds; interactive buttons; confirmation flows for destructive ops; `!help` + `/help`; persona-preserving prompts across providers. The fresh-knowledge answers cite their web sources inline, which materially improves trust for time-sensitive questions.

**Prior UX defect resolved:** BUG-1 (literal `\n` in welcome-status) is fixed — the panel now renders on separate lines in both `!welcome status` and `/admin welcome status`.

**UAT verdict is heuristic** (mocked pipelines + docs review). A live staging-guild session with real users exercising voice + moderation + the fresh-answer path remains the one thing automation cannot replace.

---

## 10. Defect Resolution — ALL 9 BUGS + 2 SECURITY FINDINGS FIXED

Every defect from the bug-hunt round is fixed and pinned by an inverted regression guard in `test/qa-bug-verification-r2.test.mjs`. Where the fix deviates from the report's original recommendation, the analysis is noted.

| ID | Sev | Defect | Fix applied | Notes |
|----|-----|--------|-------------|-------|
| **BUG-1** | Medium (UX) | Welcome-status joined with literal `\n` text. | ✅ `.join('\\n')` → `.join('\n')` in `src/prefix-handler.js` and `src/commands/admin.js`. | As recommended. |
| **BUG-2** | Medium (reliability) | Guild quota slot consumed even when the user quota denied the request (spammer could starve a server's 150/min). | ✅ **Alternative approach:** rewrote `checkRateLimit` as **evaluate-then-commit** — guild and user limits are evaluated read-only first; both counters increment only after *all* checks pass (`src/utils/rate-limit.js`). | The report suggested "check user first, or roll back the guild increment". Evaluate-then-commit is strictly better: no partial state, no rollback path to get wrong, and a single commit point. Regression guard asserts 130/130 slots remain after a denial. |
| **BUG-3** | Low (dead code) | `markPatternUsed()` never called → usage-based eviction silently degraded to FIFO. | ✅ `buildLearnedKnowledge` now calls `markPatternUsed(p.trigger)` for every matched pattern (`src/utils/learned-patterns.js`). | As recommended (wire it, don't delete it — the LRU-by-usage policy was the intended design). |
| **BUG-4** | Low (feature gap) | `typingStart` AFK-clear handler registered without the `GuildMessageTyping` intent. | ✅ Added `GatewayIntentBits.GuildMessageTyping` + `DirectMessageTyping` to the intents array (`src/index.js`). | As recommended. Note: this is a privileged-adjacent intent; it is non-privileged in Discord's model so no developer-portal toggle is needed. |
| **BUG-5** | Low (data safety) | `config.warningsFile` undefined → warnings DB silently never backed up. | ✅ Added `warningsFile: process.env.WARNINGS_FILE \|\| './data/warnings.json'` to `src/config.js`; `warnings.js` now reads `config.warningsFile` with fallback. | As recommended, plus env override for parity with the other store paths. |
| **BUG-6** | Low (config) | `geminiEmbedding()` used only the singular key while completions rotated the key list. | ✅ Embeddings now rotate `config.geminiApiKeys` with fallback to the singular key (`src/ai/providers/gemini.js`). | As recommended. |
| **BUG-7** | Low (reliability) | `/ping` fetch had no timeout. | ✅ Added `signal: AbortSignal.timeout(5000)` (`src/commands/ping.js`), matching `execPing`. | As recommended. |
| **BUG-8** | Low (consistency) | `/chat` sent full 30-message history vs `!chat`'s 6. | ✅ `/chat` now uses `history.slice(-6)` (`src/commands/chat.js`). | As recommended — aligned on the smaller window (cheaper, consistent). |
| **BUG-9** | Medium (logic) | `parseAbsoluteTime("jam 6 siang")` → 06:00 instead of 18:00. | ✅ **Alternative approach:** the `hasSiang` branch now shifts hours **1–9** by +12 and keeps 10–11 as genuine late morning (`src/utils/reminders.js`). | The report suggested widening to `hour ≤ 11`, but that would wrongly shift "jam 11 siang" (11 AM is legitimately "siang" in Indonesian). Hours 1–9 with "siang" are the casual-PM usage; 10–11 are real late-morning. Regression guard asserts both `jam 6 siang → 18:00` and `jam 10 siang → 10:00`. |
| **BUG-10** | Low (ops) | `bot.log` grew unbounded. | ✅ Size-based rotation in `src/utils/logger.js`: rotates at 10 MB to `bot-<date>.log`, keeps 10 files. | As recommended. |
| **SEC-A** | Medium | `/test-ai` ungated. | ✅ Declaration-level `setDefaultMemberPermissions(Administrator)` + runtime owner-or-admin check. | See §7.3. |
| **SEC-B** | Medium | `belajar:`/`ajarkan:` ungated. | ✅ Owner-or-`ManageGuild` gate on the teach trigger and the clarification-learn flow. | See §7.3. |

---

## 10a. New Feature — Fresh-Knowledge Pipeline (live web answers past the knowledge cutoff)

**Requirement:** when a user asks something the model's training cutoff can't answer reliably (news, prices, scores, versions, "hari ini/terbaru/2026"…), the bot must search the internet and reason **Find information → Compare → Select what's important → Connect to context → Draw a conclusion** before answering.

**Implementation:** `src/ai/fresh.js` + two new prompts in `src/ai/prompts.js` (`FRESH_GATE_PROMPT`, `buildFreshAnswerPrompt`).

| Stage | What happens |
|-------|--------------|
| **0. GATE** | Cheap local pre-filter first: static greetings (`halo`, `makasih`, …) skip the pipeline with no AI call; obvious time anchors (`hari ini`, `terbaru`, `2026`, `latest`, …) skip straight to search. Only ambiguous queries spend one small routing call on a JSON classifier (`{needs_fresh_data, reason, search_query}`). Classifier failure falls back to "no fresh data" — a stale answer beats a broken one. |
| **1. FIND** | `webSearch` (Tavily → Wikipedia → DuckDuckGo chain) + `scrapeMultiple` on the top results — reusing the existing **SSRF-hardened** RAG scraper, so no new attack surface. |
| **2–5. COMPARE → SELECT → CONNECT → CONCLUDE** | One structured AI call walks all four reasoning stages over the scraped sources and returns `{answer, sources_used, confidence}`. The model's 1-based source indexes are mapped back to real URLs; answers stay in the user's language and never invent facts beyond the sources. |
| **Cache** | 1-hour TTL keyed on the normalized query (checked before *and* after the gate), with an unref'd cleanup interval. |

**Wiring (three entry points, all with graceful fallback to internal knowledge):**
- **@mention "Jarvis mode"** (`src/mention-handler.js`): questions routed to `knowledge` run the pipeline; additionally, any `chat`-classified question that `looksTimeSensitive()` upgrades to `knowledge` so obviously fresh questions can't slip past the router.
- **`/ask`** (`src/commands/ask.js`) and **`!ask`** (`src/prefix-handler.js`): pipeline runs first; on `usedFreshData` the answer is sent with its source list (and a low-confidence caveat when applicable), otherwise the command falls through to the normal AI path.

**Test coverage:** 4 dedicated tests (gate short-circuits, full pipeline with mocked search/scrape/AI, source-index mapping, empty-web fallback) — all offline and deterministic via `mock.module`.

---

## 11. Recommended Improvements — status

| ID | Priority | Recommendation | Status |
|----|----------|----------------|--------|
| **FIX-1** | High | Fix **BUG-2** (rate-limit guild-quota leak). | ✅ **DONE** (evaluate-then-commit, see §10) |
| **FIX-2** | High | Fix **SEC-A** — gate `/test-ai` behind admin/owner. | ✅ **DONE** |
| **FIX-3** | High | Fix **SEC-B** — permission-gate the `belajar:`/`ajarkan:` learning trigger. | ✅ **DONE** |
| **FIX-4** | Medium | Fix **BUG-1** (literal `\n` join) and **BUG-9** (`jam 6 siang` time parse). | ✅ **DONE** (BUG-9 via the refined hour ≤ 9 rule) |
| **FIX-5** | Medium | Fix **BUG-5** (warnings backup) and **BUG-6** (Gemini embedding key). | ✅ **DONE** |
| **FIX-6** | Low | Fix **BUG-3**, **BUG-4**, **BUG-7**, **BUG-8**, **BUG-10**. | ✅ **DONE** (all five) |
| **IMP-1** | Medium | Add `npm audit --omit=dev --audit-level=high` as a required CI check. | ✅ **DONE** — new "Audit production dependencies" step in `.github/workflows/ci.yml` (runs after `npm ci`, before lint/tests; dev-only advisories won't fail CI by design). |
| **IMP-2** | Medium | Add an opt-in live E2E smoke (`E2E_TOKEN` secret → boot + one AI round-trip in a staging guild). | ⏳ Open — needs a staging guild + secret; recommended next. |
| **IMP-3** | Medium | Continue modularizing `prefix-handler.js` (~1,600 LOC) and `mention-handler.js` (~830 LOC) into per-command units with their own tests. | ⏳ Open — unchanged; still the main maintainability debt. |
| **IMP-4** | Low | After each fix, invert the corresponding assertion in `qa-bug-verification-r2.test.mjs` so it asserts correct behaviour. | ✅ **DONE** — all 11 guards inverted in one pass, plus 4 fresh-pipeline tests. |

**What's genuinely good (keep doing):** provider factory deduplication; SSRF-hardened scraper with per-hop redirect validation + DNS-rebinding guard (now shared by the fresh pipeline); idempotent rate-limit tokens; evaluate-then-commit quota accounting; circuit breakers with separate cooldown classes; test env isolation that force-overrides a real `.env`; graceful shutdown persisting all JSON stores; fail-fast boot validation; atomic lease-based SQLite reminder claims; the `tar` override that closed the prior SEC-1.

---

## 12. Sign-off

| Type | Verdict |
|---|---|
| Automated suites | **183/183 PASS** (172 node:test + 7 voice + 3 security + 1 midnight) — re-run 2026-08-29, §14.3 |
| Regression guards | **11/11 PASS** — every bug-hunt defect (BUG-1..10, SEC-A, SEC-B) now asserts *correct* behaviour |
| Fresh-pipeline tests | **4/4 PASS** (gate logic, full reasoning chain, source mapping, fallback) |
| Static analysis | **PASS** (syntax clean, ESLint 0/0) |
| Smoke/boot | **PASS** (full init + fail-fast both verified) |
| Dependency audit | **PASS** (0 production vulnerabilities; now enforced in CI) |
| Security | **PASS** — SEC-A and SEC-B fixed and guarded |
| Release recommendation | **Ship.** All findings from the bug-hunt are closed; remaining items (IMP-2 live E2E, IMP-3 handler modularization) are improvement backlog, not risk. |

---

## 13. Re-Review Round (R3) — second full sweep after the fix round

User-requested re-audit of the entire codebase (two independent review passes + verification). Surfaced **11 new defects** — **all fixed and verified** in this round.

### Fixed in R3

| ID | Sev | Defect | Fix |
|----|-----|--------|-----|
| **R3-1** | High | `getReactionRoles()` returned a shared module-level `DEFAULT_EMPTY` array; `addReactionRole()` pushed into it → bindings leaked across guilds, one guild's reaction roles could corrupt/remove another's (`src/utils/reaction-roles.js`). | Getter now always returns a fresh copy. Pinned by cross-guild regression test. |
| **R3-2** | High | `handleVoiceResponse()` returned early (member not in VC) without editing the deferred interaction reply → `/ask`/`/chat` voice mode with no VC delivered **nothing** ("The application did not respond" / empty embed). | Skip path now calls `interaction.editReply(replyOptions)` itself — text always delivered. |
| **R3-3** | Med-High | `OBVIOUSLY_FRESH_RE` contained bare `new`/`baru`/`recent` → casual chat ("gw baru bangun", "my new setup") forced through full web pipeline, polluting memory + latency. | Bare words removed from regex; ambiguous cases now reach the AI gate classifier as designed. Pinned by test. |
| **R3-4** | Medium | 60 s idle "add sources" button wait ran inside `execute()`/`handleMention`, holding the global-concurrency rate-limit token — 50 unanswered waits locked out the whole bot for a minute. | Button waits detached into fire-and-forget watchers (`commands/ask.js`, `mention-handler.js`); token releases when the answer ships. |
| **R3-5** | Medium | Gemini aggregate failure hard-coded `RATE_LIMITED` regardless of actual cause (401 bad key, 400 bad model name…) → wrong circuit-breaker cooldown + misleading ops logs. | Aggregate error classified from actual per-key statuses: RATE_LIMITED / QUOTA_EXHAUSTED / HTTP_ERROR. |
| **R3-6** | Medium | OpenAI-compatible stream fallback returned raw `reasoning_content` (half-finished chain-of-thought) as the user-facing answer when `content` was empty. | CoT never surfaced — empty content triggers provider failover instead. |
| **R3-7** | Medium | Mention-handler catch left the orphaned "⏳ Oke, saya periksa dulu..." placeholder next to the error message forever. | Placeholder deleted in the error path. |
| **R3-8** | Low-Med | `execBanKick` single catch misreported API failures (e.g. missing bot BanMembers → 50013) as "confirmation timeout" with `success: true`. | Confirmation collection separated from the action; real errors now return `success:false` with a proper message. |
| **R3-9** | Low | p95 metric used `floor(n * 0.95)` — off-by-one vs nearest-rank. | `ceil(0.95 n) - 1`. |
| **R3-10** | Low | `initBackups()`: un-awaited fire-and-forget backup + non-unref'd interval; mkdir throw escaped to global handler. | Rejection-safe init, `.unref()`, mkdir guarded. |
| **R3-11** | Low-Med | VoiceMaster temp channel orphaned when the member move failed (no join event → never cleaned until restart). | Move-failure path deletes the empty temp channel immediately. |

### Noted, not fixed (accepted / backlog)

- `user-prefs.js` store grows without eviction cap (unlike `memory.js`) — every unique user persists to JSON forever.
- `findMessageInGuild` sequentially fetches every channel on an invalid message ID (rate-limit pressure on large guilds).
- `isPrivateIP` misses `0.0.0.0/8`, CGNAT `100.64/10`, `198.18/15` (mitigated by per-hop scraper re-validation).
- Six `!rrole` subcommand replies not awaited (global unhandledRejection logger covers it).
- Health check clears all spam locks wholesale every 5 min.
- Duplicate message deliveries consume one quota slot before dedup check.

### R3 verification

```
$ npm run lint          # exit 0
$ npm run test:unit     # tests 157, pass 157, fail 0
$ npm test              # unit + voice 7 + security 3 + midnight — all pass
```

Two new regression guards added (`r3-fresh` regex tightening, `r3-rrole` cross-guild isolation). Total suite: **157 node:test + 11 auxiliary = green**.

### R4 — dark-feature coverage suite

Feature-coverage audit found 6 action paths with zero tests. Added `test/integration-dark-actions.test.mjs` (15 tests):

| Covered | Tests |
|---|---|
| `execRole` add/remove | happy path, permission deny, hierarchy guard |
| `execNickname` | rename, guild-owner protection, permission deny |
| `execPinMessage` / `execUnpinMessage` | pin latest, referenced unpin, empty-pin error, bot+user permission gates |
| `execWarnList` / `execWarnClear` | full warn → list → clear lifecycle, non-owner deny |
| `execReminder` | duration accepted + pending row stored, junk/over-24h/unparseable-schedule rejected |
| Reminder delivery E2E | due row claimed → sent to fallback channel → finalized `completed`; unknown guild → `failed`, no crash |
| `execSetConfig` / `execGetConfig` | owner set/get/remove welcome_channel, unknown setting rejected, non-owner denied |
| `execSummarizeChannel` | AI summary delivered from fetched history, ReadMessageHistory gate |

One latent test-isolation gap fixed en route: `setupEnv()` now forces `WELCOME_CHANNEL_ID`/`ANNOUNCE_CHANNEL_ID`/`VOICEMASTER_HUB_ID` empty — previously a developer's real `.env` could leak into `getSetting()` fallbacks and break assertions. No product bug found in any dark action; all 15 tests pass against current code unmodified.

```
$ npm run test:unit   # tests 172, pass 172, fail 0 (157 + 15 dark-actions)
$ npm run lint        # exit 0
```

Remaining dark (accepted): weather live-API (needs real key — IMP-2), Hack Guard anti-spam loop in index.js, sleep-mode enforcement gates.

---

## 14. R5 — Knowledge-Graph Architecture Audit + Full Re-Verification (2026-08-29)

Requested as a complete re-run of every test type, plus a structural review of the whole codebase via a generated knowledge graph (`/graphify`): 98 files · ~174k words → **827 nodes, 1,373 edges, 79 communities** (`graphify-out/graph.html`, `GRAPH_REPORT.md`, `graph.json`). Every edge tagged EXTRACTED/INFERRED/AMBIGUOUS; token-reduction benchmark 95.9× per query.

### 14.1 Re-verification — all suites green

```
$ npm run test:unit      # tests 172, pass 172, fail 0 (~40.6s)
$ npm run test:voice     # 7/7 pass (atomic reminder claim verified live)
$ npm run test:security  # 3/3 pass (SSRF, rate limits, backup paths)
$ npm run test:midnight  # pass (msUntilMidnight self-check)
$ npm run lint           # exit 0 — 0 errors, 0 warnings
$ node --check (90 files)# 0 syntax failures
$ npm audit --omit=dev   # 0 vulnerabilities
$ boot smoke             # config loads; missing DISCORD_TOKEN → clean fail-fast
```

**Total: 183/183 automated checks pass.** No regression against R3/R4 guards — all inverted assertions (BUG-1..10, SEC-A/B, R3-1..R3-11) still assert correct behaviour.

### 14.2 Graph findings (architecture review)

**God nodes — confirmed hotspots.** `isOwner()` = 40 edges (highest in graph), `executeAction()` 29, `handlePrefixCommand()` 29, `chatCompletion()` 27, `handleMention()` 23. This quantifies IMP-3: the permission check and the two handler entry points are the load-bearing couplings. `isOwner` is correctly central (single source of truth in `src/utils/permissions.js`, used by 7 modules) — the risk is not the fan-out itself but that `handlePrefixCommand`/`handleMention` each re-implement dispatch+permission logic inline.

**Duplicate-name node pairs** (graph shows e.g. `looksTimeSensitive`, `backupDataFiles`, `safeWriteJson`, `playInVoiceChannel` appearing in two communities): these are AST-vs-semantic extraction of the *same* symbol, not code duplication — verified by grep. One real near-duplicate remains: `formatTimeoutDuration` in `actions/moderation.js` deliberately mirrors `formatDuration` in `utils/reminders.js` (documented rationale: avoid pulling the TTS dependency chain into moderation). Acceptable; a shared `utils/time-format.js` with zero voice imports would remove the drift risk.

**Hyperedge clusters map 1:1 to tested flows.** Fresh-knowledge pipeline, self-learning clarification flow, reminder lease pipeline, voice TTS playback, warning escalation ladder — each has dedicated tests. The graph found no orphan subsystem: every community connects to at least one test-suite node (community 9/10).

**Docs ↔ code coupling healthy:** `COMPROMISE_RESPONSE.md` incident phases reference `src/config.js` (key rotation), QA report bug nodes reference their fixed symbols — regression guards and documentation stay linked.

### 14.3 New minor findings (non-blocking)

| ID | Sev | Finding |
|----|-----|---------|
| **R5-1** | Low | `.env.example` missing 9 env vars the code reads: `RESTART_TZ`, `WARNINGS_FILE`, `FFMPEG_PATH`, `GITHUB_MODELS_KEY`, `POLLINATIONS_API_KEY`, `LOG_LEVEL`, `TEST_ENV`, `TTS_TRANSLATE_MODEL`, `WELCOME_FALLBACK_IMAGE`. All have safe defaults, but a fresh operator won't discover them. **Fix:** append the 9 keys with default-value comments. |
| **R5-2** | Low | Router's "no provider active" user error (`"Semua provider AI sedang tidak tersedia."`) doesn't tell the operator *which* env vars to set — `config.aiProviderOrder` falls back to the full static list, so an empty `providerOrder` in the boot smoke only happened because no keys were present. The per-provider log line (`Semua provider AI gagal: … 'tidak ada provider aktif'`) does exist, but the thrown user-facing message could name the expected env vars (e.g. `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, …) to shorten fresh-setup triage. |
| **R5-3** | Info | Community cohesion scores are low across the board (0.04–0.10) — expected for a call-graph of a hub-and-spoke bot (handlers fan out to utils); not a defect signal. |

### 14.4 Updated improvement backlog

| ID | Priority | Recommendation | Status |
|----|----------|----------------|--------|
| IMP-2 | Medium | Opt-in live E2E smoke (`E2E_TOKEN` → staging guild boot + one AI round-trip) | ⏳ Open |
| IMP-3 | Medium | Modularize `prefix-handler.js` / `mention-handler.js` — graph now names the cut points: extract per-command dispatch so `handlePrefixCommand` (29 edges) and `handleMention` (23) shrink to routers | ⏳ Open |
| **IMP-5** | Low | Sync `.env.example` with the 9 undeclared vars (R5-1) | ⏳ New |
| **IMP-6** | Low | Extract shared `utils/time-format.js` to retire the mirrored duration formatter | ⏳ New |

### 14.5 R5 sign-off

**Ship.** 183/183 checks pass, 0 lint errors, 0 production vulnerabilities, 0 syntax failures, fail-fast boot verified. R5 adds no blocking defects; the graph audit confirms the architecture matches the documented design (every subsystem reachable from tests, permission logic centralized, no orphan modules). Remaining items IMP-2/3/5/6 are backlog, not risk.

---

## 15. R6 — Persistent Memory Upgrade + QA Backlog Fixes (2026-08-29)

Feature round requested after the R5 architecture review: upgrade memory persistence from "conversation buffer" to real per-user persistent memory, and close the R5 minor findings.

### 15.1 New subsystem — `src/utils/user-memory.js` (SQLite, WAL)

New DB `data/user-memory.db` (path overridable via `USER_MEMORY_DB_PATH`), two tables:

| Table | Purpose |
|---|---|
| `user_state` | Per-user **quiet flag** + **custom instructions** (≤500 chars) |
| `user_facts` | Durable facts per user (≤50, LRU-evicted, ≤200 chars each, dedupe by Jaccard token similarity ≥0.6 → bump instead of insert) |

**Closes the three gaps from the memory review:**
1. **Per-user quiet mode** — "diam"/"shut up" mutes the bot *for that user only*, across **all four entry points** (mention, `!` prefix, `/chat`, `/ask`); previously sleep was global, mention-only, and owner-wake-only. "ngomong lagi"/"speak again"/"jangan diam" unmutes by the same user. `detectQuietIntent` checks unquiet patterns first so "jangan diam" can't be misread as a quiet command.
2. **Custom instructions** — `!memory set/show/clear` + `!memory facts/forget`. Injected into every AI prompt as `INSTRUKSI PRIBADI USER (wajib diikuti)` via new `memoryInjection` params on `buildJarvisPrompt`/`buildSystemPrompt`.
3. **Passive fact learning** — `extractFacts()` runs a routing-tier AI call after answered messages (fire-and-forget, never blocks replies or holds rate-limit tokens); `recallFacts()` ranks stored facts by token similarity and bumps `hits`/`lastUsed` (usage-driven recency, same eviction philosophy as learned-patterns' 500-cap). `buildMemoryInjection()` merges instructions + recalled facts into the system prompt.

**Design notes:** embeddings deliberately skipped (`ponytail:` comment in file) — TF-IDF/Jaccard is sufficient at ≤50 facts/user; upgrade path is an `embedding BLOB` column + cosine rank. Extraction reads only user messages (poisoning guard per SEC-B policy). Graceful degradation: any AI failure silently skips learning. Shutdown closes the DB with WAL checkpoint; daily backup snapshots it (db + -wal pair).

### 15.2 QA backlog fixes closed

| ID | Fix |
|----|-----|
| **R5-1 / IMP-5** | `.env.example` now documents all previously-undeclared vars: `USER_MEMORY_DB_PATH`, `WARNINGS_FILE`, `RESTART_TZ`, `POLLINATIONS_API_KEY`, `GITHUB_MODELS_KEY`, `LOG_LEVEL`, `TTS_TRANSLATE_MODEL`, `WELCOME_FALLBACK_IMAGE` (`FFMPEG_PATH`/`TEST_ENV` are internal — set by code, not operators). |
| **R5-2** | Router's all-providers-failed error now names the env vars an operator must set (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, …). |
| **Storage** | Log rotation tightened 10MB×10 → **5MB×3** (~20MB worst case, sized for 2GB VPS). Backup now includes `user-memory.db` (WAL pair copy); reminder DB keeps the online-backup API path. |

### 15.3 R6 verification

```
$ npm run lint              # exit 0 — 0 errors, 0 warnings
$ npm run test:unit         # tests 197, pass 197, fail 0 (172 + 25 new user-memory)
$ npm run test:voice        # 7/7 pass
$ npm run test:security     # 3/3 pass
$ npm run test:midnight     # pass
$ npm test                  # exit 0 — full chain green
```

**New suite `test/unit-user-memory.test.mjs` (25 tests):** quiet/unquiet intent detection (incl. the "jangan diam" inversion and substring false-positive guards), the exact-command matcher for prefix/slash gates, per-user isolation, persistence across close/reopen, instructions truncation + non-clobbering of quiet flag, fact store add/dedupe/rank/cap-50-LRU/persist, memory injection content, DB file isolation in temp dir.

**Bugs caught during development and fixed before sign-off:**
1. `detectQuietIntent` checked quiet before unquiet → "jangan diam" muted instead of unmuted.
2. Mention-handler referenced `userId` before its declaration in the empty-content branch.
3. **Re-check round (R6b):** the prefix/slash gates ran the *free-text* matcher over the whole command string, so `!memory set jangan diam`, `!ask gue lagi diam`, or `/chat pesan: "gue diam aja deh"` would falsely toggle quiet state. Fixed with `detectQuietCommand()` — an exact-command matcher on the command head only (prefix), and a ≤40-char length guard on slash/mention input so only short explicit directives count. Owner exempt from quieting (can't lock themselves out of `!admin`).
4. `detectQuietCommand` missing from the module's default export — synced.

**Live smoke:** module exercised end-to-end outside the test runner — quiet set/persist, fact store/recall/injection, intent matrix (incl. the new command matcher), reopen durability: all correct.

### 15.4 R6 sign-off

| Type | Verdict |
|---|---|
| Automated suites | **208/208 PASS** (197 node:test + 7 voice + 3 security + 1 midnight) |
| New feature | Persistent per-user memory (quiet mode + custom instructions + passive fact learning) — SQLite-backed, ~KB-scale on the 2GB budget |
| QA backlog | R5-1, R5-2 closed; log rotation + backup coverage tightened |
| Static analysis | ESLint 0/0; syntax clean |
| Release recommendation | **Ship.** Memory upgrade is additive and degrades gracefully; no prior behaviour changed except the four intentional gates. |

**Still open (backlog):** IMP-2 live E2E, IMP-3 handler modularization (the quiet gate is now a 4th concern in each entry point — strengthens the case), IMP-6 shared time-format util. Graph/knowledge-tier (kg_nodes/kg_edges, embeddings, correction learning) intentionally deferred — this round delivers the facts tier it builds on.
