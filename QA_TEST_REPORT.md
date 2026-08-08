# 🧪 QA Test Report — Discord AI Chatbot

**Date:** 2026-08-08 (re-test; supersedes the 2026-08-07 report)
**Node:** v22.13.1 win32/x64 (engines require ≥22.12.0 ✅)
**Test runner:** Node built-in `node:test` (+ `--experimental-test-module-mocks`) with mocked Discord/AI
**Suite location:** `test/` (12 node:test suites, 103 cases) + `src/test-security.js` + `src/test-voice-features.js` + `scripts/midnight-restart.test.js` — wired into `npm test` + GitHub Actions CI (incl. ESLint)

---

## 1. Executive Summary

| # | Test type | Result | Evidence |
|---|---|---|---|
| 1 | **Unit testing** | ✅ **103/103 pass** (0 fail, ~19s) | `npm run test:unit` — 12 suites |
| 2 | **Integration testing** | ✅ Pass | `integration-actions` (15), `integration-handlers` (15) — mocked Discord + AI |
| 3 | **System / E2E** | ✅ Pass (offline scope) | Module-graph boot smoke, config validation, deploy-commands build, entry-point syntax — see §6 for live-Discord limitation |
| 4 | **Regression testing** | ✅ Pass | `bugs-found` (2), `regression-prior-bugs` (7) — every bug fixed on 2026-08-07 still fixed |
| 5 | **Smoke & sanity** | ✅ Pass | `compat-smoke` (7), `node --check` on all entry points, lint clean |
| 6 | **UAT** | 🟡 Partial (review-based) | No real-user session possible without connecting to Discord; command surface reviewed — see §8 |
| 7 | **Performance / load** | ✅ Pass | `perf-load` (4): 10k rate-limit calls, 5k-user memory store, backoff timing |
| 8 | **Security testing** | ✅ Pass (1 residual advisory chain) | `unit-security` (10) + `test-security.js` + `npm audit` — see §7 |
| 9 | **Usability / UX** | 🟡 Minor findings | See §8 |
| 10 | **Static analysis / lint** | ✅ Pass | ESLint 9 flat config, 0 errors |
| 11 | **Dependency / environment** | ✅ Fixed | `better-sqlite3@13.0.3` native segfault found + fixed (pinned `~12.4.6`) — see §2 |

**Verdict:** Application code is in excellent shape — all 103 automated tests pass, all previously fixed bugs hold, lint is clean, and the security posture is strong. The one blocker found this cycle (`better-sqlite3@13.0.3` native crash from the 2026-08-07 dependency bump) is **fixed**: pinned to `~12.4.6`, full `npm test` green (§2).

---

## 2. ❌ BLOCKER — BUG-3: `better-sqlite3@13.0.3` segfaults on `new Database()` (win32-x64, Node 22.13.1)

**Severity:** Critical (environment/dependency) · **Status:** ✅ **FIXED 2026-08-08** — pinned `~12.4.6` in `package.json` + lockfile, full `npm test` green

### Symptom
`npm run test:voice` dies mid-suite with a native crash:

```
[TEST] Test 4: Reminder Persistence
Segmentation fault   (exit code 139)
```

### Reproduction (minimal, application code not involved)
```js
const D = require('better-sqlite3');
const db = new D(':memory:');   // ← segfaults here, every time
```

### Isolation performed
| Experiment | Result |
|---|---|
| Minimal `new Database(':memory:')` | ❌ Segfault (exit 139) |
| Same, outside sandbox / via `cmd.exe` | ❌ Segfault (not shell- or sandbox-related) |
| `npm rebuild better-sqlite3` (re-fetch prebuilt `prebuilds/win32-x64.node`) | ❌ Still segfaults |
| `npm rebuild --build-from-source` | ❌ Still segfaults (install script falls back to prebuild-install) |
| Clean reinstall (`rm -rf node_modules/better-sqlite3 && npm i better-sqlite3@13.0.3`) | ❌ Still segfaults |
| **`better-sqlite3@12.4.6` (same machine, same Node)** | ✅ **Works perfectly** |
| Full `test:voice` suite on v12.4.6 | ✅ All 7 tests pass (incl. SQLite migration, persistence, atomic claim) |

### Conclusion
The v13 "N-API rewrite" prebuilt binary (`prebuilds/win32-x64.node`, shipped 2026-08-07 with the dependency bump) crashes on database construction on this machine. `require()` succeeds; the crash is native, inside the constructor. No matching upstream issue was found in the WiseLibs tracker at the time of writing. The crash is **not** caused by application code — `src/utils/reminder-store.js` was verified correct against v12.4.6 (schema migration v2, legacy-JSON migration, WAL mode, atomic claim/lease all pass).

### Impact if deployed as-is
`src/utils/reminder-store.js` imports `better-sqlite3` and opens the DB on first reminder use — **the bot process would crash with a native segfault** (and be restarted by the supervisor into a crash loop) the moment any reminder feature is touched.

### Fix applied (2026-08-08)
```json
"better-sqlite3": "~12.4.6"
```
`package.json` + `package-lock.json` now pin v12.4.6 (installed version confirmed `12.4.6`). Full `npm test` re-run after the pin: **unit 103 pass / 0 fail, voice 7/7, security all pass, midnight ok**. Optional follow-up: file an upstream issue with the repro above so the `^13` line can be re-adopted once fixed.

---

## 3. ✅ Unit Testing — 103/103 pass

| Suite | Cases | Covers |
|---|---|---|
| `unit-utils.test.mjs` | 24 | memory store, reminders, formatter, metrics, wake-sleep, `needsContext` regex |
| `integration-actions.test.mjs` | 15 | moderation/voice/utility actions end-to-end with mocked Discord |
| `integration-handlers.test.mjs` | 15 | prefix & mention handlers, command routing, dedup, owner guards |
| `unit-security.test.mjs` | 10 | SSRF, protocol whitelist, IP-literal & DNS-rebinding guards |
| `unit-warnings.test.mjs` | 9 | unified escalation ladder (#3 → 10-min timeout, #5 → kick, fallbacks) |
| `compat-smoke.test.mjs` | 7 | ESM imports, 8 commands export `data`+`execute`, config validation, `.gitignore` |
| `regression-prior-bugs.test.mjs` | 7 | pins every fix from the 2026-08-07 cycle |
| `unit-sanitizer.test.mjs` | 6 | control-char stripping, truncation, injection resistance |
| `unit-router.test.mjs` | 4 | AI provider round-robin, bounded counter |
| `perf-load.test.mjs` | 4 | see §5 |
| `bugs-found.test.mjs` | 2 | BUG-1/BUG-2 duration parsing (still fixed) |
| `unit-learned-patterns.test.mjs` | 1 | monotonic pattern IDs across 501-pattern eviction |
| `unit-voice-player.test.mjs` | 1 | connection-error destroy, no connection leak |

Plus the standalone suites:
- **`test:security`** — SSRF prevention, rate limits, backup path resolution: **all pass**
- **`test:voice`** — 7/7 pass on sqlite v12 (display-name sanitize, Indonesian time parser, reminder text sanitize, persistence + schema v2 migration, voice queue integrity, welcome hub, atomic claim)
- **`test:midnight`** — `msUntilMidnight` supervisor timing: **pass**

---

## 4. ✅ Regression Testing

Every defect from the previous cycle remains fixed and is pinned by an automated test:

| Prior defect | Pinned by | Status |
|---|---|---|
| BUG-1: `parseDuration()` double-counts compact units (`1h`→2h) | `bugs-found` | ✅ holds |
| BUG-2: `execTimeout()` substring collision (`1 jam`→1 min, `30 detik`→30 days) | `bugs-found` | ✅ holds |
| Denied requests releasing rate-limit tokens they never held | `regression-prior-bugs` | ✅ holds |
| `cleanupRateLimits()` wiping in-flight tokens | `regression-prior-bugs` | ✅ holds |
| Mention rate-limit missing guild dimension | `regression-prior-bugs` | ✅ holds |
| Router round-robin unbounded counter | `unit-router` | ✅ holds |
| Pattern-ID collision after eviction | `unit-learned-patterns` | ✅ holds |
| Voice connection error → process crash/leak | `unit-voice-player` | ✅ holds |
| Warning reason stored as `[object Object]` | `unit-warnings` | ✅ holds |

No regressions detected anywhere in the suite.

---

## 5. ✅ Performance / Load Testing

- **Rate limiter:** 10,000 `checkRateLimit()` calls complete in ms; user (20/min), guild (150/min), and global concurrency (50) caps all hold under load; token release correct.
- **Memory store:** 5,000 concurrent user histories — capped at 30 msgs/user, no unbounded growth, lookups stay O(1)-ish.
- **Backoff timing:** network retry backoff verified within tolerance.
- **Reminder store:** SQLite WAL mode + `busy_timeout=5000`, indexed `(status, triggerAt)` due-claims, atomic lease claims (verified by voice test 7) — safe for the multi-instance supervisor setup.
- **Observed:** full 103-case suite completes in ~19s; no timeouts, no memory-pressure failures.

No performance defects found. The only historical perf-adjacent issues (unbounded router counter, map growth) were fixed 2026-08-07 and stay fixed.

---

## 6. System / E2E & Smoke

Performed (offline-safe):
- ✅ All entry points parse: `index.js`, `src/index.js`, `src/deploy-commands.js`, `scripts/midnight-restart.js` (`node --check`).
- ✅ Core module graph boots with real env: `config → ai/router → rag/pipeline → actions → reminder-store` import cleanly.
- ✅ `deploy-commands` builds all 8 slash commands (compat-smoke).
- ✅ Config validation: exits non-zero with a clear message when `DISCORD_TOKEN`/`DISCORD_CLIENT_ID` are absent (compat-smoke spawns from a clean cwd). *Note: running from the project root with a populated `.env` correctly loads — dotenv reads the file regardless of shell env; this is expected, not a validation bypass.*
- ✅ `.env` and `data/*.json` gitignored; no secret patterns in tracked JS.

**Limitation (disclosed):** a true live E2E run (bot login against Discord, real voice join, real AI provider calls) was **not** executed — it requires connecting to Discord with the production token, an outward-facing action outside the scope of an automated QA pass. The mocked-Discord integration suites cover the handler logic; recommend one supervised live smoke in a staging guild before release.

---

## 7. Security Testing

**Automated (all pass):**
- **SSRF:** private IPv4 (incl. `169.254.169.254`), IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, localhost, non-http(s) protocols (`file:`, `ftp:`, `gopher:`), malformed URLs — all denied. Re-reviewed `src/utils/security.js` this cycle: WHATWG URL parsing normalizes hex/octal/decimal IPv4 tricks before the checks, and the connect-time `safeLookup` agents close the DNS-rebinding TOCTOU gap (both `all:false` and `all:true` shapes handled).
- **AuthZ:** owner + permission + role-hierarchy checks on all destructive actions; kick/ban confirm buttons; `MentionEveryone` gate on announcements; non-owner escalation attempts rejected.
- **Rate limiting / Hack Guard:** user/guild/global caps, spam lock, auto-moderation ladder (unified `applyWarningEscalation`).
- **Secrets:** `.env` gitignored; no tokens in source.
- **Injection:** no `eval`/`new Function`/shell injection in production source; sanitizer strips control chars.

**`npm audit` (residual, unchanged from 2026-08-07):** 5 vulns (1 critical, 4 high) — all nested under `@discordjs/node-pre-gyp` (install-time-only dependency of `@discordjs/opus`), `tar` chain with **no fixed release** in the declared range. Not exercised at runtime; known upstream limitation. Re-audit after the better-sqlite3 pin (§2), as v12 also ships prebuilds and needs no node-pre-gyp path.

---

## 8. Usability / UX & UAT (review-based)

- ✅ Consistent bilingual (Indonesian-first) UX: `/help` renders a single embed via `buildHelpEmbed()`; prefix (`!`) and mention routes mirror slash commands; empty-mention greeting; unknown commands silently ignored (no error spam).
- ✅ Moderation actions require confirmation buttons with a working cancel path — good destructive-action UX.
- ✅ Clear user-facing error strings for rate limits, permissions, and duration clamps (28-day Discord cap is labelled).
- 🟡 **Minor:** two handler files are getting large (`prefix-handler.js` 1,019 lines, `mention-handler.js` 820, `src/index.js` 608) — command routing, AI fallback, and moderation are interleaved, which raises the risk of UX drift between entry points (the exact class of bug the unified `warnings.js` policy just fixed). Consider extracting shared command-dispatch tables.
- 🟡 **Minor:** duration input accepts Indonesian + English + compact forms (great), but milliseconds silently floor to 0 (`10ms` → 0) — either document or reject sub-second input explicitly.

**UAT note:** scripted acceptance against the feature list (chat, RAG, reminders, voice TTS, moderation, weather, summarize) passes at the mocked level; a human UAT pass in a staging guild remains the one open item (§6).

---

## 9. Findings Register (this cycle)

| ID | Severity | Finding | Status |
|---|---|---|---|
| BUG-3 | 🔴 Critical | `better-sqlite3@13.0.3` native segfault on `new Database()` (win32-x64, Node 22.13.1); crashes `test:voice` and would crash the bot at runtime | ✅ **FIXED 2026-08-08** — pinned `~12.4.6` in `package.json` + lockfile, full suite green |
| OBS-1 | 🟡 Low | Large handler files (1k+ lines) mixing routing/AI/moderation — drift risk | Recommended refactor, non-blocking |
| OBS-2 | 🟡 Low | `10ms` duration silently parses to 0 | Document or reject sub-second input |
| OBS-3 | 🟡 Low | 5 nested `npm audit` vulns via `@discordjs/opus` install-time `tar` — no upstream fix | Known limitation, monitor |
| OBS-4 | ℹ️ Info | Live-Discord E2E + human UAT not executed (requires outward connection) | Schedule staging-guild smoke before release |

---

## 10. Recommended Priorities

1. ~~**Pin `better-sqlite3` to `~12.4.6`**~~ ✅ **Done 2026-08-08** — pinned in `package.json` + lockfile, `npm test` fully green. Optional: file the upstream segfault report with the §2 repro.
2. **Run one supervised live smoke** in a staging guild (login, `/ping`, mention chat, reminder set/deliver, voice TTS) to close the E2E/UAT gap.
3. Extract shared dispatch logic from `prefix-handler.js` / `mention-handler.js` / `index.js` (OBS-1) when next touching those files.
4. Keep CI green: the existing GitHub Actions workflow (`npm ci && npm test` + lint) already covers everything in this report — note that CI on `windows-latest` would have caught BUG-3; consider adding a Windows job to the matrix.

---

*Run everything with: `npm test` (unit → voice → security → midnight) and `npm run lint`. BUG-3 fixed 2026-08-08: `better-sqlite3` pinned to `~12.4.6` in `package.json` + `package-lock.json` — safe for clean installs (`npm ci`).*
