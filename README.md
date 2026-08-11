<div align="center">

# Discord AI Bot

A modular Discord assistant for AI chat, web-grounded answers, voice interaction, moderation, reminders, and server automation.

[![CI](https://github.com/cyberjo26/discord-aichatbot/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberjo26/discord-aichatbot/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)

[Features](#features) · [Commands](#commands) · [Getting Started](#getting-started) · [Configuration](#configuration) · [Architecture](#architecture) · [Testing](#testing) · [Contributing](#contributing)

</div>

---

## Overview

This project is a self-hosted Discord AI bot built with Node.js, [discord.js](https://discord.js.org/), and a pluggable multi-provider AI router. It supports both traditional commands and natural-language interaction through Discord mentions.

The bot is designed around a few practical goals:

- **Useful conversation:** chat, ask questions, summarize content, and maintain user context.
- **Grounded answers:** optionally search the web and attach source links through the RAG pipeline.
- **Server automation:** moderation, role management, reminders, welcome messages, and temporary voice channels.
- **Resilience:** provider rotation, automatic failover, circuit breakers, rate limiting, persistent state, and health checks.
- **Flexible deployment:** use one AI provider or combine several providers with a configurable routing order.

> The bot is primarily implemented with Indonesian user-facing messages, while the codebase and documentation use both English and Indonesian terminology.

## Features

### AI conversations

- **Jarvis mode:** mention the bot in a server, or message it directly in a DM, to start a natural-language conversation.
- **Slash and prefix commands:** use `/ask`, `/chat`, `!ask`, or `!chat` depending on your preferred workflow.
- **Conversation memory:** `/chat` and conversational mentions use in-memory user context with configurable limits and expiry; this context is not durable across process restarts.
- **Self-learning patterns:** teach the bot an unfamiliar phrase with `belajar:` or `ajarkan:`, explain it, then send `UPDATE` so the pattern is stored and reused.
- **Personalized responses:** interaction preferences and learned patterns can influence future responses.
- **Owner controls:** the owner can inspect bot/provider health, clear a user’s memory, and change the active OpenRouter model until restart.

### Web search and summarization

- **RAG pipeline:** search, scrape, and summarize web sources before producing a grounded answer.
- **Search fallback chain:** Tavily when configured, then Indonesian/English Wikipedia and DuckDuckGo.
- **On-demand sources:** `/ask` answers directly first and provides a button to add web sources afterward.
- **URL summarization:** `/summarize <url>` validates the URL, fetches the article, and returns an AI-generated summary.
- **Channel summarization:** natural-language actions can summarize recent messages from the current channel.
- **SSRF protection:** URL fetching rejects unsupported protocols and private or restricted network addresses.

### Voice and audio

- **Voice replies:** `/ask` and `/chat` support `mode: voice`; prefix commands also provide `!ask-voice` and `!chat-voice`.
- **Text-to-speech:** Edge TTS is supported with configurable language, voice, rate, and pitch.
- **English translation mode:** voice responses translate to English by default before synthesis; disable with `TTS_TRANSLATE_ENGLISH=false`.
- **Custom TTS:** an OpenAI-compatible TTS endpoint can be configured, with Edge TTS fallback behavior.
- **Voice welcome:** optionally greet members with generated speech when they join a voice channel.
- **VoiceMaster:** create a hub that automatically provisions temporary voice channels and cleans them up.
- **Voice moderation:** inspect voice occupancy or mute, deafen, and disconnect members through natural-language actions.

### Moderation and server tools

- **Hack Guard:** detects repeated messages across multiple channels, removes matching spam, and applies warning/escalation logic.
- **Warnings:** persistent warnings with automated escalation policies.
- **Moderation actions:** timeout, kick, ban, role add/remove, nickname changes, channel creation/deletion, pin/unpin, and message pruning.
- **Permission-aware execution:** destructive actions check Discord permissions, role hierarchy, and owner privileges.
- **Reaction roles:** create panels and map emoji reactions to roles with `/reactionrole` or `!rrole`.
- **AFK system:** set an AFK reason, notify users who mention or reply to an AFK member, and clear the status when the member returns or starts typing.
- **Reminders:** schedule text, voice, or combined reminders using relative durations or absolute times; reminders are stored in SQLite and restored after restart.
- **Server configuration:** configure welcome and announcement channels and other per-guild settings.
- **Utilities:** live weather, Discord/HTTP latency, invite links, help, and generated member welcome messages.
- **Sleep mode:** the owner can put the bot to sleep; it stops normal processing until explicitly woken.

### AI provider routing

The router supports the following provider adapters:

| Provider | Configuration | Notes |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | Default primary adapter; supports a configurable model and fallback model list |
| Gemini | `GEMINI_API_KEY` | Direct Gemini completion and embedding support |
| Groq | `GROQ_API_KEY` | OpenAI-compatible completion endpoint |
| Cerebras | `CEREBRAS_API_KEY` | OpenAI-compatible completion endpoint |
| Pollinations | `POLLINATIONS_API_KEY` | Implemented adapter; the example marks it as legacy/throttled |
| Puter | `PUTER_API_KEY` | OpenAI-compatible completion endpoint |
| Custom | `CUSTOM_AI_*` | Any compatible OpenAI-style gateway, including multiple keys/models |

The router provides:

- Round-robin provider order rotation.
- Automatic failover when a provider fails or times out.
- Per-provider circuit breakers.
- Separate cooldowns for rate limits, quota exhaustion, and repeated failures.
- Request counts, successes, failures, average latency, and circuit state for admin status output.

## Commands

### Slash commands

Commands are defined in `src/commands/` and registered with `npm run deploy-commands`.

| Command | Description |
|---|---|
| `/ask <pertanyaan> [mode]` | Ask a question. Choose `text` or `voice`; optionally add web sources with the response button. |
| `/chat <pesan> [mode]` | Chat with memory context in text or voice mode. |
| `/summarize <url>` | Fetch and summarize a web article. |
| `/weather <lokasi>` | Show real-time weather for a city or country. |
| `/ping` | Show Discord Gateway and Google HTTP latency. |
| `/invite` | Generate an invite link with the bot’s required permissions. |
| `/help` | Display the interactive help embed. |
| `/reactionrole setup <title> [description] [message_id]` | Create a panel, or reuse an existing message by supplying `message_id`; `title` remains required by Discord. |
| `/reactionrole add` | Bind an emoji on a message to a role. |
| `/reactionrole remove` | Remove one emoji/role binding. |
| `/reactionrole remove-all` | Remove all bindings from a message. |
| `/reactionrole list` | List reaction-role bindings for the server. |
| `/reactionrole set-emoji` | Replace an existing binding’s emoji. |
| `/admin status` | Owner-only uptime, health, metrics, and provider dashboard. |
| `/admin say` | Owner-only message relay through the bot. |
| `/admin execute` | Owner-only direct AI prompt execution. |
| `/admin clear-memory <user>` | Owner-only memory deletion for a user. |
| `/admin set-model <model>` | Owner-only temporary OpenRouter model change. |
| `/admin voice` | Owner-only voice-channel occupancy report. |
| `/admin voice-welcome [enabled]` | Owner-only voice welcome status/toggle. |

The remaining `/admin` subcommands require the configured owner account. `/reactionrole` requires the Discord **Manage Roles** permission.

### Prefix commands

Prefix commands use `!` and are handled by `src/prefix-handler.js`.

| Category | Commands |
|---|---|
| Conversation | `!ask <question>`, `!ask-voice <question>`, `!chat <message>`, `!chat-voice <message>`, `!summarize <url>`, `!help` |
| AFK | `!afk [reason]`, `!afk off` |
| Voice | `!cvoice [channel]`, `!voice on\|off\|status`, `!admin-voice`, `!admin-voicewelcome on\|off\|toggle` |
| Moderation | `!warn`, `!bungkam`, `!kick`, `!dc`, `!to`, `!prune`, `!cn` |
| Owner | `!admin-say`, `!admin-status`, `!admin-execute`, `!admin-model`, `!admin-clear`, `!act` |
| Utilities | `!ping`, `!weather` / `!cuaca`, `!invite` / `!undang` |
| Reaction roles | `!rrole setup`, `!rrole add`, `!rrole remove`, `!rrole remove-all`, `!rrole list`, `!rrole set-emoji` |

Exact arguments and permission checks are implemented in `src/prefix-handler.js`. Natural-language mentions can also trigger supported actions such as moderation, reminders, voice controls, configuration, and utility operations. For exact arguments, start with `/help` or inspect the action handlers in `src/actions/`.

### Natural-language examples

```text
@bot siapa pendiri Google?
@bot rangkum artikel ini https://example.com/article
@bot mute @user
@bot timeout @user 10 menit
@bot kasih role VIP ke @user
@bot ingatkan aku 10 menit lagi untuk meeting
@bot siapa yang sedang di voice?
@bot tidur
```

For self-learning:

```text
@bot belajar: "ngopi dulu"
Aku biasanya memakai kalimat itu saat ingin istirahat sebentar.
UPDATE
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) **22.12 or newer**.
- A Discord application and bot token.
- At least one required AI key: `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, or `CEREBRAS_API_KEY`.
- Discord intents enabled in the Developer Portal:
  - **Message Content Intent**
  - **Server Members Intent**
- Additional Discord permissions for the features you enable, such as voice, moderation, channel management, role management, and message reactions.

### Installation

```bash
git clone https://github.com/cyberjo26/discord-aichatbot.git
cd discord-aichatbot
npm install
```

Create your local environment file:

```bash
# macOS/Linux/Git Bash
cp .env.example .env

# Windows Command Prompt
copy .env.example .env
```

At minimum, set:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_application_id
OPENROUTER_API_KEY=your_openrouter_key
```

You can use Gemini, Groq, or Cerebras instead of OpenRouter. Only one of those four required provider keys is needed to pass startup validation.

Register slash commands and start the bot:

```bash
# Guild deployment: set GUILD_ID in .env for near-instant development updates
npm run deploy-commands

# Development with Node's file watcher
npm run dev

# Production-style start
npm start
```

Without `GUILD_ID`, commands are registered globally and Discord may take up to an hour to propagate them. Deploy commands again whenever slash-command definitions change.

### Optional supervisor

```bash
npm run start:midnight
```

This starts the bot through the daily restart supervisor. The restart timezone is controlled by `RESTART_TZ` or `TIMEZONE`.

### Persistence

Runtime state is stored under `data/` by default:

- SQLite reminder data: `data/voice-reminders.db`
- JSON state for AFK, user preferences, learned patterns, wake/sleep state, and server settings.
- Automatic backups for supported JSON stores.

Use persistent storage when deploying to a container or cloud host. The `data/` directory contains runtime state and should not be committed.

## Configuration

The complete annotated template is available in [`.env.example`](.env.example). The tables below list the most important settings and runtime defaults from `src/config.js`.

### Discord and server settings

| Variable | Default | Description |
|---|---:|---|
| `DISCORD_TOKEN` | — | **Required.** Bot token. |
| `DISCORD_CLIENT_ID` | — | **Required.** Application/client ID. |
| `GUILD_ID` | — | Optional guild ID for fast slash-command deployment. |
| `OWNER_ID` | — | Discord user ID with owner-only controls. |
| `BOT_NAME` | `AI Bot` | Display name used in prompts and embeds. |
| `TIMEZONE` | `Asia/Bangkok` | Timezone used by reminders and scheduled behavior. |
| `WELCOME_CHANNEL_ID` | — | Optional fallback welcome channel. |
| `ANNOUNCE_CHANNEL_ID` | — | Optional announcement channel. |
| `MOD_LOG_CHANNEL_ID` | — | Optional moderation log channel. |

### AI routing

| Variable | Default | Description |
|---|---:|---|
| `AI_PROVIDER_ORDER` | `openrouter,gemini,groq,cerebras,pollinations,puter,custom` | Provider order before round-robin rotation. |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter. |
| `OPENROUTER_MODEL` | `openrouter/free` | Primary OpenRouter model. |
| `OPENROUTER_FALLBACK_MODELS` | — | Comma-separated OpenRouter fallback models. |
| `GEMINI_API_KEY` | — | Enables Gemini completion and embeddings. |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model. |
| `GROQ_API_KEY` | — | Enables Groq. |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model. |
| `CEREBRAS_API_KEY` | — | Enables Cerebras. |
| `CEREBRAS_MODEL` | `Qwen/Qwen3-32B` | Cerebras model. |
| `POLLINATIONS_API_KEY` | — | Optional legacy Pollinations adapter. |
| `PUTER_API_KEY` | — | Enables Puter. |
| `PUTER_MODEL` | `claude-3-5-sonnet` | Puter model. |
| `AI_REQUEST_TIMEOUT_MS` | `12000` | Provider timeout before failover. |
| `AI_CIRCUIT_FAILURE_THRESHOLD` | `2` | Failures before a circuit opens. |
| `AI_CIRCUIT_COOLDOWN_MS` | `30000` | Standard circuit cooldown. |
| `AI_RATELIMIT_COOLDOWN_MS` | `60000` | Cooldown after rate-limit errors. |
| `AI_QUOTA_COOLDOWN_MS` | `300000` | Cooldown after quota errors. |

> `.env.example` uses `AI_REQUEST_TIMEOUT_MS=20000` as an explicit sample value. If the variable is omitted, the runtime default is 12 seconds.

#### Custom OpenAI-compatible AI

Set the base URL, one or more keys, and one or more models, then include `custom` in `AI_PROVIDER_ORDER`:

```dotenv
CUSTOM_AI_BASE_URL=https://api.example.com/v1/chat/completions
CUSTOM_AI_API_KEYS=key_one,key_two
CUSTOM_AI_MODELS=model_one,model_two
CUSTOM_AI_AUTH_PREFIX=Bearer
CUSTOM_AI_EXTRA_HEADERS={"X-Project-ID":"example"}
AI_PROVIDER_ORDER=openrouter,gemini,groq,cerebras,puter,custom
```

### Voice and TTS

| Variable | Default | Description |
|---|---:|---|
| `TTS_TRANSLATE_ENGLISH` | `true` | Translate chat/action voice responses to English before synthesis. |
| `TTS_LANGUAGE` | `id-ID` | Edge TTS language. |
| `TTS_VOICE` | — | Explicit Edge TTS voice override. |
| `TTS_RATE` | `+0%` | Speech rate. |
| `TTS_PITCH` | `+0Hz` | Speech pitch. |
| `CUSTOM_TTS_BASE_URL` | — | OpenAI-compatible TTS endpoint. |
| `CUSTOM_TTS_API_KEY` | — | Custom TTS API key. |
| `CUSTOM_TTS_MODEL` | — | Custom TTS model; enables the custom endpoint. |
| `CUSTOM_TTS_VOICE` | `alloy` | Custom TTS voice. |
| `CUSTOM_TTS_LANGUAGE` | `TTS_LANGUAGE` | Custom TTS language. |
| `CUSTOM_TTS_RESPONSE_FORMAT` | `mp3` | Custom TTS response format. |
| `CUSTOM_TTS_SPEED` | `1` | Custom TTS playback speed. |
| `CUSTOM_TTS_TIMEOUT_MS` | `30000` | Custom TTS request timeout. |

### Search, memory, and storage

| Variable | Default | Description |
|---|---:|---|
| `TAVILY_API_KEY` | — | Optional preferred web-search provider. Wikipedia and DuckDuckGo remain available as fallbacks. |
| `DATABASE_PATH` | `./data/voice-reminders.db` | SQLite reminder database. |
| `LEGACY_REMINDERS_FILE` | `./data/voice-reminders.json` | Optional legacy reminder migration source. |
| `SERVER_SETTINGS_FILE` | `./data/server-settings.json` | Per-guild settings store. |
| `MAX_TOKENS_DEFAULT` | `512` | Default AI response token budget. |
| `MAX_TOKENS_ROUTING` | `220` | Routing/classification token budget. |
| `MAX_TOKENS_SIMPLE_CHAT` | `512` | Simple chat/summarization token budget. |
| `MAX_TOKENS_COMPLEX_CHAT` | `1000` | Knowledge/code-help token budget. |
| `SECRET_BEHAVIOR` | Built-in persona | Optional custom system behavior/persona. |

## Architecture

```text
src/
├── index.js                 Discord client, events, startup, shutdown, health loop
├── config.js                Environment parsing and runtime defaults
├── mention-handler.js       Jarvis mode, routing, learning, natural-language actions
├── prefix-handler.js        ! commands and prefix-based management
├── deploy-commands.js       Slash-command registration
├── commands/                Slash-command definitions and executors
├── actions/                 Reusable moderation, voice, memory, summary, utility actions
├── ai/
│   ├── router.js             Provider rotation, failover, circuit breakers, metrics
│   ├── prompts.js            System, RAG, routing, and persona prompts
│   └── providers/             OpenRouter, Gemini, Groq, Cerebras, Pollinations, Puter, custom
├── rag/                     Search, scraping, and grounded-answer pipeline
├── voice/                   TTS synthesis, audio playback, and voice welcome
└── utils/                   Memory, AFK, reminders, warnings, security, settings, backups,
                             reaction roles, VoiceMaster, rate limits, logging, and health
```

### Message flow

```text
Discord event
  ├─ slash command ────────┐
  ├─ ! prefix command ─────┼─> rate limit -> command/action -> response
  ├─ @mention / DM ────────┘
  └─ reaction / voice event ─> role, voice, or server automation

AI request -> provider order rotation -> enabled provider
          -> success, or failover/circuit-breaker handling

/ask sources button -> search -> scrape -> RAG prompt -> answer + source links
```

### Reliability and security

- Atomic JSON writes and graceful shutdown flushing.
- SQLite-backed reminder persistence and recovery.
- Provider health metrics, rate limiting, cooldowns, and circuit breakers.
- Input sanitization and duplicate-message protection.
- Permission and Discord role-hierarchy checks before moderation actions.
- URL protocol, DNS, private-IP, and DNS-rebinding protections for remote fetching.
- GitHub Actions CI runs linting and the complete test suite on Node.js 22.

## Testing

Install dependencies first, then run:

```bash
# Lint the project
npm run lint

# Full suite: unit, voice, security, and restart supervisor tests
npm test

# Focused suites
npm run test:unit
npm run test:voice
npm run test:security
npm run test:midnight
```

The test suite covers the provider router, input sanitizer, security helpers, learned patterns, warnings, AFK behavior, voice playback, integration handlers, performance/regression cases, and the midnight restart supervisor.

## Development notes

- Keep secrets in `.env`; never commit tokens or API keys.
- Run `npm run deploy-commands` after changing slash-command definitions.
- Use `GUILD_ID` during development so command changes appear quickly.
- Use a persistent `data/` volume in production.
- Grant only the Discord permissions needed by the features enabled on your server.
- When adding a provider, implement the adapter and register it in `src/ai/router.js` and `src/config.js`.
- When adding a command, update both `src/deploy-commands.js` and the command collection in `src/index.js`.

## Contributing

1. Fork the repository.
2. Create a focused branch:

   ```bash
   git checkout -b feat/your-change
   ```

3. Make the change and add or update tests where appropriate.
4. Run `npm run lint` and `npm test`.
5. Open a pull request with a concise description, screenshots or command examples for user-facing changes, and notes about configuration changes.

## License

This repository does not currently include a `LICENSE` file or an explicit license in `package.json`. Treat the code as **all rights reserved** unless the project owner adds licensing terms. If you plan to redistribute or publish a derivative, clarify the intended license first.

## Ringkasan Bahasa Indonesia

Bot ini adalah asisten Discord AI multifungsi dengan **Jarvis Mode**, chat dan tanya jawab, pencarian web dengan sumber, voice/TTS, moderasi, AFK, reminder SQLite, self-learning, VoiceMaster, reaction roles, dan routing AI multi-provider dengan failover otomatis.

Jalankan dengan menyalin `.env.example` ke `.env`, isi `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, dan minimal satu API key AI (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, atau `CEREBRAS_API_KEY`), lalu jalankan `npm run deploy-commands` dan `npm start`.
