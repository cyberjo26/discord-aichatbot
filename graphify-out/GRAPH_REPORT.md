# Graph Report - .  (2026-08-06)

## Corpus Check
- Corpus is ~40,743 words - fits in a single context window. You may not need a graph.

## Summary
- 361 nodes · 705 edges · 17 communities detected
- Extraction: 64% EXTRACTED · 36% INFERRED · 0% AMBIGUOUS · INFERRED: 251 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Reminders & Backups|Reminders & Backups]]
- [[_COMMUNITY_Commands & Admin Prefix|Commands & Admin Prefix]]
- [[_COMMUNITY_Moderation Actions|Moderation Actions]]
- [[_COMMUNITY_AI Routing & Prompts|AI Routing & Prompts]]
- [[_COMMUNITY_Mention Handler & Gemini|Mention Handler & Gemini]]
- [[_COMMUNITY_Core Bootstrap & Settings|Core Bootstrap & Settings]]
- [[_COMMUNITY_Voice & TTS Pipeline|Voice & TTS Pipeline]]
- [[_COMMUNITY_RAG Search Pipeline|RAG Search Pipeline]]
- [[_COMMUNITY_Admin & Health Monitoring|Admin & Health Monitoring]]
- [[_COMMUNITY_Utility Commands|Utility Commands]]
- [[_COMMUNITY_Security & Rate Limiting|Security & Rate Limiting]]
- [[_COMMUNITY_Root Supervisor|Root Supervisor]]
- [[_COMMUNITY_Midnight Restart Script|Midnight Restart Script]]
- [[_COMMUNITY_Custom OpenAI Provider|Custom OpenAI Provider]]
- [[_COMMUNITY_OpenRouter Provider|OpenRouter Provider]]
- [[_COMMUNITY_Logger Module|Logger Module]]
- [[_COMMUNITY_Config Entry Point|Config Entry Point]]

## God Nodes (most connected - your core abstractions)
1. `isOwner()` - 34 edges
2. `executeAction()` - 29 edges
3. `handleMention()` - 26 edges
4. `handlePrefixCommand()` - 25 edges
5. `chatCompletion()` - 24 edges
6. `runTests()` - 15 edges
7. `openReminderStore()` - 14 edges
8. `ragPipeline()` - 12 edges
9. `generateNaturalResponse()` - 10 edges
10. `handleChat()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Actions modularization out of mention-handler` --references--> `handleMention()`  [EXTRACTED]
  Improvment.md → src\mention-handler.js
- `Slash Commands (src/commands)` --references--> `handlePrefixCommand()`  [INFERRED]
  Project_Analysis.md → src\prefix-handler.js
- `Utility Commands (summarize/weather/ping/invite)` --references--> `execPing()`  [INFERRED]
  README.md → src\actions\utility.js
- `Utility Commands (summarize/weather/ping/invite)` --references--> `execWeather()`  [INFERRED]
  README.md → src\actions\utility.js
- `Multi-Provider AI Load Balancing` --references--> `chatCompletion()`  [INFERRED]
  README.md → src\ai\router.js

## Hyperedges (group relationships)
- **Voice pipeline: join â†’ synthesize â†’ play** — voice_player_playinvoicechannel, voice_tts_synthesize, voice_tts_condenseforvoice, utils_voice_response_handlevoiceresponse [EXTRACTED 1.00]
- **AI provider fallback chain** — ai_router_chatcompletion, src_ai_providers_openai_factory_js, readme_multi_provider, project_analysis_ai_subsystem [INFERRED 0.80]
- **Refactoring effort: actions modularization & review cycle** — improvment_actions_modularization, code_review_bugs, task_refactoring_verification, src_mention_handler_handlemention [EXTRACTED 1.00]

## Communities

### Community 0 - "Reminders & Backups"
Cohesion: 0.09
Nodes (42): execReminder(), SQLite local persistence, cleanup(), logger(), resetTestReminders(), runTests(), backupDataFiles(), initBackups() (+34 more)

### Community 1 - "Commands & Admin Prefix"
Cohesion: 0.1
Nodes (40): buildJarvisPrompt(), execute(), execute(), Slash Commands (src/commands), handleAdminClear(), handleAdminExecute(), handleAdminSay(), handleAdminSetModel() (+32 more)

### Community 2 - "Moderation Actions"
Cohesion: 0.08
Nodes (35): execBanKick(), execCreateChannel(), execDeleteChannel(), execNickname(), execPinMessage(), execRole(), execTimeout(), execUnpinMessage() (+27 more)

### Community 3 - "AI Routing & Prompts"
Cohesion: 0.08
Nodes (29): buildAgentRoutingPrompt(), buildRagPrompt(), buildSystemPrompt(), chatCompletion(), circuitOpen(), providerOrder(), recordFailure(), recordSuccess() (+21 more)

### Community 4 - "Mention Handler & Gemini"
Cohesion: 0.11
Nodes (28): geminiCompletion(), geminiEmbedding(), isGeminiEnabled(), providerError(), toGeminiPayload(), Hybrid Self-Learning Feature, analyzeAndPlan(), fastRoute() (+20 more)

### Community 5 - "Core Bootstrap & Settings"
Cohesion: 0.11
Nodes (23): execGetConfig(), execSetConfig(), Full codebase architecture & file inventory, shutdown(), safeWriteJson(), forceSavePatterns(), forceSaveSettings(), getAllSettings() (+15 more)

### Community 6 - "Voice & TTS Pipeline"
Cohesion: 0.14
Nodes (14): Shared voice response helper, Voice & TTS Subsystem (src/voice), Voice Mode Feature, handleVoiceResponse(), getMemberVoiceChannel(), playInVoiceChannel(), condenseForVoice(), isCustomTtsConfigured() (+6 more)

### Community 7 - "RAG Search Pipeline"
Cohesion: 0.17
Nodes (13): RAG Search Subsystem (src/rag), normalizeQuery(), ragPipeline(), scrapeMultiple(), scrapeUrl(), searchDuckDuckGo(), searchTavily(), searchWikipedia() (+5 more)

### Community 8 - "Admin & Health Monitoring"
Cohesion: 0.2
Nodes (13): getAiStats(), execute(), handleClearMemory(), handleExecute(), handleSay(), handleSetModel(), handleStatus(), handleVoice() (+5 more)

### Community 9 - "Utility Commands"
Cohesion: 0.16
Nodes (11): execInvite(), execPing(), execWeather(), Code review: duplicated logic across handlers, execute(), execute(), Utility Commands (summarize/weather/ping/invite), buildInviteUrl() (+3 more)

### Community 10 - "Security & Rate Limiting"
Cohesion: 0.23
Nodes (8): Offline unit & security test results, Utility & Infrastructure Modules (src/utils), runTests(), checkRateLimit(), cleanupRateLimits(), releaseRateLimit(), isPrivateIP(), isSafeUrl()

### Community 11 - "Root Supervisor"
Cohesion: 0.57
Nodes (6): msUntilMidnight(), scheduledRestart(), startBot(), ts(), waitForExit(), write()

### Community 12 - "Midnight Restart Script"
Cohesion: 0.67
Nodes (5): log(), msUntilMidnight(), scheduledRestart(), startBot(), waitForExit()

### Community 13 - "Custom OpenAI Provider"
Cohesion: 0.67
Nodes (2): customCompletion(), isCustomEnabled()

### Community 14 - "OpenRouter Provider"
Cohesion: 0.83
Nodes (3): isOpenRouterEnabled(), openRouterCompletion(), providerError()

### Community 15 - "Logger Module"
Cohesion: 0.83
Nodes (3): getDateString(), timestamp(), writeToFile()

### Community 16 - "Config Entry Point"
Cohesion: 0.67
Nodes (1): Root & Entry Points

## Knowledge Gaps
- **11 isolated node(s):** `Chat Memory Feature`, `Hybrid Self-Learning Feature`, `SQLite local persistence`, `Full codebase architecture & file inventory`, `RAG Search Subsystem (src/rag)` (+6 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Custom OpenAI Provider`** (4 nodes): `buildCustomProviders()`, `customCompletion()`, `isCustomEnabled()`, `custom-openai.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Config Entry Point`** (3 nodes): `Root & Entry Points`, `envList()`, `config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `executeAction()` connect `Moderation Actions` to `Reminders & Backups`, `Commands & Admin Prefix`, `Mention Handler & Gemini`, `Core Bootstrap & Settings`, `Utility Commands`?**
  _High betweenness centrality (0.200) - this node is a cross-community bridge._
- **Why does `chatCompletion()` connect `AI Routing & Prompts` to `Commands & Admin Prefix`, `Moderation Actions`, `Mention Handler & Gemini`, `Voice & TTS Pipeline`, `RAG Search Pipeline`, `Admin & Health Monitoring`?**
  _High betweenness centrality (0.176) - this node is a cross-community bridge._
- **Why does `handleMention()` connect `Mention Handler & Gemini` to `Commands & Admin Prefix`, `Moderation Actions`, `AI Routing & Prompts`, `Admin & Health Monitoring`, `Utility Commands`, `Security & Rate Limiting`?**
  _High betweenness centrality (0.146) - this node is a cross-community bridge._
- **Are the 31 inferred relationships involving `isOwner()` (e.g. with `handleMention()` and `gatherServerContext()`) actually correct?**
  _`isOwner()` has 31 INFERRED edges - model-reasoned connections that need verification._
- **Are the 26 inferred relationships involving `executeAction()` (e.g. with `execPing()` and `execWeather()`) actually correct?**
  _`executeAction()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 11 inferred relationships involving `handleMention()` (e.g. with `checkRateLimit()` and `isBotAwake()`) actually correct?**
  _`handleMention()` has 11 INFERRED edges - model-reasoned connections that need verification._
- **Are the 17 inferred relationships involving `chatCompletion()` (e.g. with `analyzeAndPlan()` and `generateNaturalResponse()`) actually correct?**
  _`chatCompletion()` has 17 INFERRED edges - model-reasoned connections that need verification._