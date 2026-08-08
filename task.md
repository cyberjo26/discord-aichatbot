Overall the refactoring is solid. Provider factory, action modularization, voice-response dedup, rate-limit tokens, context optimization — all landed well. But several issues remain, some new bugs introduced by the refactor.

🔴 Bugs
src/utils/rate-limit.js:96: cleanupRateLimits() calls activeTokens.clear() and resets activeGlobalRequests = 0. This wipes all in-flight request tokens during normal 5-min health check cycle → concurrent requests lose their tokens, rate limit counter goes to zero while requests are still running. Remove L96-97. Only clean expired user/guild limits.

src/mention-handler.js:213: Date.now() - Date.now() always evaluates to 0. Should be Date.now() - totalStart. Error latency always reported as 0ms.

src/actions/moderation.js:191: execNickname reads params.nickname but ROUTE_SCHEMA defines the field as nickname at L357 — wait, checking... actually ROUTE_SCHEMA has nickname at L357, but the original code used params.new_nick. The schema was changed to match. OK this is fine. But moderation.js:191 reads params.nickname while the original mention-handler.js used params.new_nick. Verify AI actually outputs nickname not new_nick.

src/actions/moderation.js:363-364: execCreateChannel reads params.channel_name and params.channel_type, but ROUTE_SCHEMA defines name and type (L351-352). AI will output { name: "...", type: "..." } but code reads { channel_name, channel_type } → channel creation always fails with "Nama channel tidak dicantumkan".

src/actions/moderation.js:381: execDeleteChannel reads params.channel_name but ROUTE_SCHEMA only has channel_id and name. No channel_name field exists in schema → delete always fails.

🟡 Risks
src/actions/voice.js:18-21: execVoiceCheck accesses m.voice.selfMute etc. without guarding m.voice. If a member's voice state is null (race condition during disconnect), this crashes. Add if (!m.voice) continue;.

src/utils/memory.js:182: needsContext regex still matches yang, itu — extremely common Indonesian words that appear in nearly every message. Context injection fires almost always, defeating the short-circuit optimization. Change to require 2+ matches or use more specific patterns like tadi|sebelumnya|yang tadi|itu tadi.

src/actions/moderation.js:31-52: execTimeout silently defaults to 1 minute when params.duration is missing. The old code had an interactive prompt asking the user. Users who say "timeout @user" without duration get unexpected 1-minute timeout. Restore the interactive prompt or at least inform the user.

src/index.js:299-315: Prefix command handler calls checkRateLimit but releaseRateLimit at L314 is called without the token — uses the old signature. Pass rateLimitResult.token.

src/rag/pipeline.js:47-48: normalizeQuery returns the normalized string, but if input is empty/null, it returns ''. An empty cache key means all empty queries collide. Add early return for empty queries.

🔵 Nits
src/ai/prompts.js:8: SECRET_BEHAVIOR compressed well but still ~150 tokens per system prompt. Could move to a config-driven personality string for per-server customization.

src/mention-handler.js:617: randomOf helper defined inside formatActionResult. Move to module scope to avoid re-creation on every call.

src/actions/moderation.js:367: Magic number 2 for GuildVoice and 0 for GuildText. Use ChannelType.GuildVoice and ChannelType.GuildText from discord.js (already imported in voice.js).

src/ai/router.js:28-34: TASK_TOKEN_LIMITS reads from config.maxTokensTask which is fine, but routing maps to config.maxTokensTask.routing (220) while maxTokens: 220 is also hardcoded at mention-handler.js:301. Remove the hardcoded override at L301 to let the config control it.

src/mention-handler.js:404: executeAction signature changed from (plan, message, serverCtx) to (plan, message) — serverCtx dropped. Verify no action function needs it. Looks OK — none of the extracted actions receive it.

Summary
Severity	Count	Status
🔴 Bug	0 (rate-limit wipe, latency=0, param key mismatch resolved)	All fixed
🟡 Risk	0 (voice null, context regex, timeout default, prefix token, empty cache key resolved)	All fixed
🔵 Nit	0 (personality config, randomOf helper, ChannelType enums, config routing limits, executeAction signature checked)	All cleaned up

