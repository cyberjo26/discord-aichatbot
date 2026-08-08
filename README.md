<div align="center">

# 🤖 Discord AI Chatbot

**A multi-functional, self-learning AI Discord bot that searches the web, speaks in voice channels, moderates your server, and never goes down — all powered by a multi-provider AI load balancer.**

[🇮🇩 Bahasa Indonesia](#-bahasa-indonesia)

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14.x-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)
![Tests](https://img.shields.io/badge/tests-103%20passing-brightgreen)

[Features](#-features) · [Command Reference](#-command-reference) · [Quick Start](#-quick-start) · [Configuration](#-configuration) · [Architecture](#-architecture) · [Testing](#-testing) · [Roadmap](#-roadmap)

</div>

---

## ✨ Features

### 🧠 AI-Powered Conversations
| Feature | Description |
|---|---|
| **Jarvis Mode** | Mention `@bot` and talk naturally — no commands needed. The bot understands intent and acts on it. |
| **RAG Search** | `/ask` answers with grounded, source-backed information from the web (Tavily / Wikipedia / DuckDuckGo). |
| **Chat Memory** | Remembers conversation context per user (30 messages, 2h TTL) with automatic context summarization. |
| **Self-Learning** | Teach the bot new command patterns in plain language — it remembers them forever and applies them automatically. |
| **Multi-Step Thinking** | Handles complex, multi-step requests with structured reasoning. |

### 🔊 Voice & Audio
| Feature | Description |
|---|---|
| **Voice Replies** | Bot joins your voice channel and *speaks* answers (`!ask-voice`, `!chat-voice`, voice mode in slash commands). |
| **English TTS Translation** | Voice replies are automatically translated to **English** and spoken with an English voice (`en-US-AriaNeural`). Disable with `TTS_TRANSLATE_ENGLISH=false`. |
| **Custom TTS Support** | Any OpenAI-compatible TTS endpoint (primary), falling back to Edge TTS. |
| **Voice Welcome** | Personalized spoken greetings when members join voice channels (per-guild toggle). |
| **VoiceMaster** | Auto-created temporary voice channels with automatic cleanup. |

### 🛡️ Moderation & Security
| Feature | Description |
|---|---|
| **Hack Guard** | Anti-spam that detects identical messages across 3+ channels (hacked-account / self-bot pattern), deletes them, and escalates. |
| **Warning System** | `/warn` with persistent history and automatic escalation: **3 warnings → 10min timeout · 5 warnings → kick**. |
| **Full Mod Suite** | Mute, kick, disconnect, timeout, prune, nickname — via prefix commands *or* natural language. |
| **Rate Limiting** | Per-user + global AI concurrency limiting to prevent API abuse. |
| **Sleep Mode** | Owner can put the bot to sleep (`@bot tidur`) — it stops responding until woken. |

### 😴 AFK System
- `!afk [reason]` — set your AFK status (e.g. `!afk tidur`), `!afk off` to clear.
- **Natural language detection** — just say *"gw afk dulu mau makan"* or *"I'm going afk for dinner"* and the bot sets it for you.
- Anyone who **mentions or replies** to an AFK user gets notified: `😴 @user sedang AFK: makan (5 menit lalu)`.
- Auto-clears the moment the user **sends a message or starts typing** — no unreliable presence hacks.

### ⏰ Reminders & Utility
- `@bot ingatkan aku 10 menit lagi` — voice/chat reminders persisted in SQLite, restored across restarts.
- `/weather`, `/summarize`, `/ping`, `/invite` utilities.
- **Welcome messages** for new members (AI-generated).
- **Health checks** every 5 minutes (DB, AI providers, gateway) with automatic log snapshots.

### 🔀 AI Multi-Provider Load Balancer
- **Round-robin rotation** across providers: **OpenRouter · Gemini · Groq · Cerebras · Puter** (+ optional custom OpenAI-compatible endpoint).
- **Automatic failover** — if a provider errors, times out, or hits a quota limit, the next one is tried instantly.
- **Circuit breaker** per provider — repeatedly failing providers are temporarily skipped so the bot stays fast.
- **Per-provider timeouts** (default 20s) so one slow API never blocks a reply.
- `!admin-status` shows live per-provider health: success rate, average latency, circuit state.

---

## 📚 Command Reference

### Slash Commands

| Command | Description |
|---|---|
| `/ask <pertanyaan> [mode]` | AI answer with optional web sources (button) and voice mode |
| `/chat <pesan> [mode]` | Natural chat with memory context (text/voice) |
| `/summarize <url>` | Summarize any web article |
| `/weather <lokasi>` | Live weather forecast |
| `/ping` | Latency check |
| `/invite` | Bot invite link |
| `/help` | Interactive help |
| `/admin say` | Send a message as the bot |
| `/admin execute` | Ask the AI anything (owner) |
| `/admin status` | Bot + AI provider health dashboard |
| `/admin set-model <model>` | Hot-swap the primary AI model |
| `/admin clear-memory <user>` | Wipe a user's chat memory |
| `/admin voice` | Who's in which voice channel |
| `/admin voice-welcome` | Toggle voice welcome |

### Prefix Commands (`!`)

| Category | Commands |
|---|---|
| **Chat** | `!ask` · `!ask-voice` · `!chat` · `!chat-voice` · `!summarize <url>` |
| **AFK** | `!afk [reason]` · `!afk off` — or just *say* you're going AFK |
| **Voice info** | `!cvoice [channel]` — member list with mute/deafen/live status |
| **Moderation** (Admin/Mod) | `!warn @user [reason]` · `!bungkam @user` · `!kick @user` · `!dc @user` · `!to @user <durasi>` · `!prune <1-100>` · `!cn @user <nick>` |
| **Owner** | `!admin-voice` · `!admin-say` · `!admin-status` · `!admin-execute` · `!admin-model` · `!admin-clear` · `!admin-voicewelcome on\|off\|toggle` · `!act <channelId> <pesan>` |
| **Utility** | `!ping` · `!weather <lokasi>` / `!cuaca` · `!invite` / `!undang` |

### 🗣️ Jarvis Mode (Natural Language)

Just mention the bot and say what you want:

```
@bot siapa pendiri Google?
@bot rekomendasi belajar backend
@bot siapa yang di voice?
@bot mute @user / kasih role VIP ke @user / timeout @user 10 menit
@bot ganti nick @user jadi Budi
@bot ingatkan aku 10 menit lagi
```

DM the bot to chat directly — no mention needed in DMs.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js ≥ 22.12**
- A [Discord bot token](https://discord.com/developers/applications) with the **Message Content** and **Server Members** intents enabled
- At least one AI API key (see below)

### Installation

```bash
# 1. Clone & install
git clone https://github.com/your-username/discord-aichatbot.git
cd discord-aichatbot
npm install

# 2. Configure
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, and your AI keys

# 3. Register slash commands
npm run deploy-commands

# 4. Run
npm run dev      # development (auto-restart on changes)
npm start        # production
```

> 💡 **Data persistence:** all state lives in the `data/` folder (SQLite + JSON stores). Make it a persistent volume if deploying with Docker or a cloud host. `npm run start:midnight` runs the bot with an automatic daily restart.

### Getting an AI key (free options)

| Provider | Where | Notes |
|---|---|---|
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | Free tier, huge model catalog, recommended primary |
| **Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Generous free quota |
| **Groq** | [console.groq.com](https://console.groq.com) | Very fast, free tier |
| **Cerebras** | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Fast inference |
| **Puter** | [puter.com](https://puter.com) | Free |

---

## ⚙️ Configuration

### Core

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Bot token |
| `DISCORD_CLIENT_ID` | — | **Required.** Application ID |
| `GUILD_ID` | — | Guild to register commands to (faster dev deploys) |
| `OWNER_ID` | — | Your Discord user ID — unlocks `/admin` & `!admin` |
| `BOT_NAME` | `AI Bot` | Bot display name |
| `TIMEZONE` | `Asia/Bangkok` | IANA timezone for reminders |

### AI Routing

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER_ORDER` | `openrouter,gemini,groq,cerebras,puter` | Provider failover order (round-robin rotated). Append `custom` to add an OpenAI-compatible endpoint |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | — / `openrouter/free` | OpenRouter |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash-lite` | Gemini |
| `GROQ_API_KEY` / `GROQ_MODEL` | — / `llama-3.1-8b-instant` | Groq |
| `CEREBRAS_API_KEY` / `CEREBRAS_MODEL` | — / `Qwen/Qwen3-32B` | Cerebras |
| `PUTER_API_KEY` / `PUTER_MODEL` | — / `claude-3-5-sonnet` | Puter |
| `AI_REQUEST_TIMEOUT_MS` | `12000` (`.env.example` ships `20000`) | Per-provider timeout before failover |
| `AI_CIRCUIT_FAILURE_THRESHOLD` | `2` | Consecutive failures before circuit opens |
| `AI_CIRCUIT_COOLDOWN_MS` | `30000` | Circuit breaker cooldown |
| `AI_RATELIMIT_COOLDOWN_MS` | `60000` | Cooldown after rate-limit errors |
| `AI_QUOTA_COOLDOWN_MS` | `300000` | Cooldown after quota errors |
| `OPENROUTER_FALLBACK_MODELS` | — | Comma-separated fallback models in one request |

> **Custom OpenAI-compatible provider:** set `CUSTOM_AI_BASE_URL` + `CUSTOM_AI_API_KEYS` + `CUSTOM_AI_MODELS` and add `custom` to `AI_PROVIDER_ORDER` to route through any OpenAI-compatible gateway.

### Text-to-Speech

| Variable | Default | Description |
|---|---|---|
| `TTS_TRANSLATE_ENGLISH` | `true` | Translate voice replies to English + English voice |
| `TTS_LANGUAGE` | `id-ID` | Edge TTS language |
| `TTS_VOICE` | — | Explicit Edge voice override (e.g. `en-US-AriaNeural`) |
| `TTS_RATE` / `TTS_PITCH` | `+0%` / `+0Hz` | Speech rate & pitch |
| `CUSTOM_TTS_BASE_URL` / `CUSTOM_TTS_MODEL` | — | Use a custom OpenAI-compatible TTS endpoint |
| `CUSTOM_TTS_VOICE` / `CUSTOM_TTS_SPEED` | `alloy` / `1` | Custom TTS voice & speed |

### Persistence & Extras

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/voice-reminders.db` | Reminder SQLite database |
| `SERVER_SETTINGS_FILE` | `./data/server-settings.json` | Per-guild settings |
| `TAVILY_API_KEY` | — | Better web search (free 1000 credits/mo) |
| `WELCOME_CHANNEL_ID` / `ANNOUNCE_CHANNEL_ID` | — | Welcome / announcement channels |
| `MOD_LOG_CHANNEL_ID` | — | Moderation alert channel |
| `MAX_TOKENS_*` | various | Per-task token budgets |
| `SECRET_BEHAVIOR` | — | Custom bot persona/prompt |

---

## 🏗️ Architecture

```
src/
├── index.js              # Entry point — event wiring, spam guard, shutdown
├── config.js             # All environment configuration
├── prefix-handler.js     # '!' prefix commands
├── mention-handler.js    # @mention Jarvis mode + DM chat
├── deploy-commands.js    # Slash command registration
├── ai/
│   ├── router.js         # Provider failover, round-robin, circuit breaker
│   ├── prompts.js        # System prompts & personas
│   └── providers/        # openrouter · gemini · groq · cerebras · puter · custom
├── commands/             # Slash command definitions
├── actions/              # Shared action executors (voice, moderation, memory…)
├── rag/                  # Web search + scraping + RAG pipeline
├── voice/                # TTS synthesis, voice player, voice welcome
└── utils/                # AFK, warnings, reminders, memory, learned patterns,
                          # user prefs, server settings, voicemaster, rate limit,
                          # health, metrics, logger, backups, security…
```

**Data flow for a chat message:** `messageCreate` → spam guard → AFK check → command route (`!prefix` / `@mention` / slash) → `chatCompletion` → provider router (failover + circuit breaker) → optional RAG grounding → embed/voice reply.

**Resilience:** atomic JSON writes, crash-safe store flushing (`uncaughtException`/shutdown), SQLite reminders, automatic backups, and a 5-minute health-check loop.

---

## ✅ Testing

```bash
npm run lint          # ESLint
npm test              # Full suite: unit + voice + security + midnight-restart
npm run test:unit     # Unit tests (router, sanitizer, security, utils, voice…)
npm run test:voice    # Voice feature tests
npm run test:security # Security tests
```

The suite covers the provider router, sanitizer, learned patterns, warnings, voice player, regression for previously-fixed bugs, and more — **103 tests passing**.

---

## 🗺️ Roadmap

- [x] Multi-provider AI routing with circuit breaker
- [x] RAG web search with source grounding
- [x] Voice replies with English TTS translation
- [x] AFK system with natural-language detection
- [x] Self-learning command patterns
- [x] Hack Guard anti-spam + warning escalation
- [ ] Web dashboard for live metrics
- [ ] More slash-command coverage for prefix commands
- [ ] Multi-language TTS (beyond EN translation)

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/awesome`)
3. Commit your changes
4. Open a pull request

Please run `npm run lint` and `npm test` before submitting.

---

## 📄 License

MIT © [Your Name]

---

## 🇮🇩 Bahasa Indonesia

Bot Discord AI multifungsi yang "hidup": **Jarvis Mode** (tag `@bot` dan bicara natural), **RAG search** dengan sumber, **Voice mode** yang membacakan jawaban (otomatis diterjemahkan ke Bahasa Inggris), **AFK system** (ketik `!afk alasan` atau bilang *"gw afk dulu mau makan"* — bot otomatis mengatur, memberitahu yang mention kamu, dan menghapus status saat kamu kembali), **self-learning** (ajari bot pola baru dengan `UPDATE`), **moderasi lengkap** (warning dengan eskalasi otomatis, Hack Guard anti-spam), **reminder**, dan **load-balancer AI multi-provider** (OpenRouter, Gemini, Groq, Cerebras, Puter) dengan failover otomatis dan circuit breaker.

**Cara menjalankan:** salin `.env.example` → `.env`, isi `DISCORD_TOKEN` + `DISCORD_CLIENT_ID` + minimal satu API key AI, jalankan `npm run deploy-commands` lalu `npm start`.

*README ini ditulis dalam Bahasa Inggris untuk tampilan GitHub yang profesional. Konten lengkap fitur & konfigurasi ada di bagian atas.*
