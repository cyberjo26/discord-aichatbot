# 🤖 Discord AI Chatbot — Full Codebase Architecture & File Inventory

Complete structural and architectural breakdown covering **100% of all 44 source files** in the codebase. Built with **Node.js (v22+)** and **discord.js v14**.

---

## 📁 Complete File Inventory (44 Files)

### 1. Root & Entry Points (3 Files)
| File Path | Description |
| :--- | :--- |
| [index.js](file:///d:/testprojek/discord-aichatbot-main/index.js) | Root entry point alias — imports `src/index.js`. |
| [src/index.js](file:///d:/testprojek/discord-aichatbot-main/src/index.js) | Core bot bootstrapper: Discord Client setup, event listeners (`messageCreate`, `interactionCreate`, `voiceStateUpdate`, `guildMemberAdd`), Hack Guard anti-spam, health check loop, graceful shutdown. |
| [src/config.js](file:///d:/testprojek/discord-aichatbot-main/src/config.js) | Centralized configuration loader. Parses `.env` variables (tokens, AI thresholds, DB paths, TTS settings, circuit breaker timeouts). |
| [src/deploy-commands.js](file:///d:/testprojek/discord-aichatbot-main/src/deploy-commands.js) | Utility script to register/update Discord Slash Commands globally or per guild via REST API. |

---

### 2. Event & Intent Handlers (2 Files)
| File Path | Description |
| :--- | :--- |
| [src/mention-handler.js](file:///d:/testprojek/discord-aichatbot-main/src/mention-handler.js) | AI Agent pipeline for `@mention` messages. Resolves natural language intent via AI router, executes moderation/actions, generates Jarvis replies, handles article buttons, voice responses, and self-learning triggers. |
| [src/prefix-handler.js](file:///d:/testprojek/discord-aichatbot-main/src/prefix-handler.js) | Command handler for `!` prefix commands (`!ask`, `!chat`, `!summarize`, `!weather`, `!ping`, `!invite`, `!admin`, `!warn`, `!bungkam`, `!kick`, etc.). |

---

### 3. AI Core Subsystem (`src/ai/` — 10 Files)
| File Path | Description |
| :--- | :--- |
| [src/ai/router.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/router.js) | Multi-provider load balancer and circuit breaker fallback controller across 6 AI providers. |
| [src/ai/prompts.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/prompts.js) | System prompts, identity locks (Tsundere persona), RAG prompts, Jarvis assistant mode, action classifier schema. |
| [src/ai/openrouter.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/openrouter.js) | OpenRouter wrapper alias re-export. |
| [src/ai/providers/gemini.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/gemini.js) | Google Gemini API provider adapter with safety filter cleanup. |
| [src/ai/providers/openrouter.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/openrouter.js) | OpenRouter provider adapter supporting fallback model arrays. |
| [src/ai/providers/groq.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/groq.js) | Groq Llama provider adapter. |
| [src/ai/providers/cerebras.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/cerebras.js) | Cerebras provider adapter. |
| [src/ai/providers/pollinations.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/pollinations.js) | Pollinations AI provider adapter. |
| [src/ai/providers/puter.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/puter.js) | Puter AI provider adapter. |
| [src/ai/providers/openai-factory.js](file:///d:/testprojek/discord-aichatbot-main/src/ai/providers/openai-factory.js) | Universal OpenAI-compatible client factory constructor. |

---

### 4. RAG Search Subsystem (`src/rag/` — 3 Files)
| File Path | Description |
| :--- | :--- |
| [src/rag/pipeline.js](file:///d:/testprojek/discord-aichatbot-main/src/rag/pipeline.js) | RAG orchestrator: query normalization, search execution, page scraping, prompt assembly, and answer generation with sources. |
| [src/rag/search.js](file:///d:/testprojek/discord-aichatbot-main/src/rag/search.js) | Multi-engine web search aggregator (Tavily API, DuckDuckGo scraper, Wikipedia API). |
| [src/rag/scraper.js](file:///d:/testprojek/discord-aichatbot-main/src/rag/scraper.js) | Page text extractor using `axios` and `cheerio` HTML parser. |

---

### 5. Action Modules (`src/actions/` — 6 Files)
| File Path | Description |
| :--- | :--- |
| [src/actions/index.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/index.js) | Barrel export for all action execution modules. |
| [src/actions/moderation.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/moderation.js) | Moderation actions (timeout, kick, ban, warnings, roles, nicknames, channel create/delete, voice moderation). |
| [src/actions/memory.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/memory.js) | Conversation history tracking, context injection, topic extraction. |
| [src/actions/summary.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/summary.js) | Content summarizer for URLs and Discord channel message histories. |
| [src/actions/utility.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/utility.js) | Utility execution logic (`ping`, `weather` via Open-Meteo API, `invite` generator). |
| [src/actions/voice.js](file:///d:/testprojek/discord-aichatbot-main/src/actions/voice.js) | Voice channel joining & TTS audio playback invocation. |

---

### 6. Voice & TTS Subsystem (`src/voice/` — 3 Files)
| File Path | Description |
| :--- | :--- |
| [src/voice/player.js](file:///d:/testprojek/discord-aichatbot-main/src/voice/player.js) | `@discordjs/voice` connection manager and audio player with idle auto-disconnect. |
| [src/voice/tts.js](file:///d:/testprojek/discord-aichatbot-main/src/voice/tts.js) | Text-To-Speech generator using `node-edge-tts` (Microsoft Neural TTS). |
| [src/voice/welcome.js](file:///d:/testprojek/discord-aichatbot-main/src/voice/welcome.js) | Auto TTS audio greeting when users join designated voice channels. |

---

### 7. Slash Commands (`src/commands/` — 8 Files)
| File Path | Description |
| :--- | :--- |
| [src/commands/ask.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/ask.js) | `/ask` slash command (RAG search). |
| [src/commands/chat.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/chat.js) | `/chat` slash command (AI conversation memory). |
| [src/commands/summarize.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/summarize.js) | `/summarize` slash command (URL/channel summary). |
| [src/commands/help.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/help.js) | `/help` slash command (command directory & guide). |
| [src/commands/admin.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/admin.js) | `/admin` slash command (owner management controls). |
| [src/commands/ping.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/ping.js) | `/ping` slash command (latency metrics). |
| [src/commands/weather.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/weather.js) | `/weather` slash command (live weather lookup). |
| [src/commands/invite.js](file:///d:/testprojek/discord-aichatbot-main/src/commands/invite.js) | `/invite` slash command (bot invite link builder). |

---

### 8. Utility & Infrastructure Modules (`src/utils/` — 22 Files)
| File Path | Description |
| :--- | :--- |
| [src/utils/voicemaster.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/voicemaster.js) | VoiceMaster system ("VC • User" temp channel generator & auto-cleanup). |
| [src/utils/reminders.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/reminders.js) | Reminder scheduler loop & notification dispatcher. |
| [src/utils/reminder-store.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/reminder-store.js) | SQLite database manager (`better-sqlite3`) for persistent reminders. |
| [src/utils/learned-patterns.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/learned-patterns.js) | Self-learning engine (`UPDATE` trigger parser & persistent pattern store). |
| [src/utils/server-settings.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/server-settings.js) | Per-guild configuration persistence (`data/server-settings.json`). |
| [src/utils/user-prefs.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/user-prefs.js) | User communication preference & topic interest tracker. |
| [src/utils/rate-limit.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/rate-limit.js) | Sliding-window concurrency & rate limiting per user/guild. |
| [src/utils/memory.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/memory.js) | In-memory user conversation history buffer. |
| [src/utils/discord-helpers.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/discord-helpers.js) | Regex ID extractors & target member search resolver. |
| [src/utils/formatter.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/formatter.js) | Discord Embed UI builders (chat, RAG, error, admin embeds). |
| [src/utils/permissions.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/permissions.js) | Bot owner & member permission checkers. |
| [src/utils/warnings.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/warnings.js) | Warning store & auto-punishment tracker (`data/warnings.json`). |
| [src/utils/wake-sleep.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/wake-sleep.js) | Bot sleep/wake toggle state manager. |
| [src/utils/voice-response.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/voice-response.js) | Voice response helper for mention pipeline. |
| [src/utils/health.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/health.js) | System health check (DB connectivity & AI provider status). |
| [src/utils/backup.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/backup.js) | Automatic JSON data file backup manager. |
| [src/utils/logger.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/logger.js) | Formatted console logger with timestamps & color labels. |
| [src/utils/metrics.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/metrics.js) | In-memory performance metric & latency recorder. |
| [src/utils/file-utils.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/file-utils.js) | Atomic JSON file reader & writer. |
| [src/utils/network.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/network.js) | Network reachability & ping helper. |
| [src/utils/security.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/security.js) | Input sanitizer & security threat detection. |
| [src/utils/weather.js](file:///d:/testprojek/discord-aichatbot-main/src/utils/weather.js) | Open-Meteo weather API client wrapper. |

---

### 9. Test Scripts (2 Files)
| File Path | Description |
| :--- | :--- |
| [src/test-security.js](file:///d:/testprojek/discord-aichatbot-main/src/test-security.js) | Automated security test runner for prompt injection & input sanitization. |
| [src/test-voice-features.js](file:///d:/testprojek/discord-aichatbot-main/src/test-voice-features.js) | Integration test runner for TTS audio synthesis & VoiceMaster logic. |

---

## 📊 Total File Count Summary

| Category | File Count |
| :--- | :---: |
| **Root & Entry Points** | 4 |
| **Handlers (Mention & Prefix)** | 2 |
| **AI Subsystem (`src/ai/`)** | 10 |
| **RAG Subsystem (`src/rag/`)** | 3 |
| **Actions (`src/actions/`)** | 6 |
| **Voice Subsystem (`src/voice/`)** | 3 |
| **Slash Commands (`src/commands/`)** | 8 |
| **Utilities (`src/utils/`)** | 22 |
| **Test Suite** | 2 |
| **TOTAL JS FILES** | **44** |
