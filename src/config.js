import dotenv from 'dotenv';

// dotenv 17+ logs an "injecting env" line to stderr by default; silence it
// (logging is noisy for a long-running bot and breaks clean log parsing).
dotenv.config({ quiet: true });

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env variable: ${key}`);
    console.error(`   Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
}

if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.CEREBRAS_API_KEY) {
  console.error('Missing AI provider key: isi salah satu dari OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, atau CEREBRAS_API_KEY.');
  process.exit(1);
}

function envList(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const configuredProviderOrder = envList('AI_PROVIDER_ORDER', ['openrouter', 'gemini', 'groq', 'cerebras', 'pollinations', 'puter', 'custom'])
  .filter((name) => name === 'openrouter' || name === 'gemini' || name === 'groq' || name === 'cerebras' || name === 'pollinations' || name === 'puter' || name === 'custom');

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.GUILD_ID || null,

  // Owner — ID Discord kamu (bisa kontrol penuh bot)
  ownerId: process.env.OWNER_ID || null,

  // Channel IDs (opsional)
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || null,   // Channel untuk welcome member baru
  announceChannelId: process.env.ANNOUNCE_CHANNEL_ID || null,  // Channel default untuk announcement
  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || null,     // Channel untuk alert moderasi manual (auto-kick gagal)

  // Tavily Search API (opsional, gratis 1000 credits/bulan: https://tavily.com/)
  tavilyApiKey: process.env.TAVILY_API_KEY || null,

  // OpenRouter
  openRouterKey: process.env.OPENROUTER_API_KEY || null,
  openRouterUrl: 'https://openrouter.ai/api/v1/chat/completions',
  primaryModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
  openRouterFallbackModels: envList('OPENROUTER_FALLBACK_MODELS'),

  // Gemini direct API. Used automatically when OpenRouter is unavailable.
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',

  // Groq API
  groqApiKey: process.env.GROQ_API_KEY || null,
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',

  // Cerebras API
  cerebrasApiKey: process.env.CEREBRAS_API_KEY || null,
  cerebrasUrl: 'https://api.cerebras.ai/v1/chat/completions',
  cerebrasModel: process.env.CEREBRAS_MODEL || 'Qwen/Qwen3-32B',

  // Pollinations API
  pollinationsApiKey: process.env.POLLINATIONS_API_KEY || null,
  pollinationsUrl: 'https://text.pollinations.ai/openai',

  // Puter API
  puterApiKey: process.env.PUTER_API_KEY || null,
  puterUrl: 'https://api.puter.com/puterai/openai/v1/chat/completions',
  puterModel: process.env.PUTER_MODEL || 'claude-3-5-sonnet',

  // Custom OpenAI-compatible API (any platform with an OpenAI-compatible endpoint)
  customAiBaseUrl: process.env.CUSTOM_AI_BASE_URL || '',
  customAiApiKeys: envList('CUSTOM_AI_API_KEYS', [process.env.CUSTOM_AI_API_KEY || '']).filter(Boolean),
  customAiModels: envList('CUSTOM_AI_MODELS', [process.env.CUSTOM_AI_MODEL || '']).filter(Boolean),
  customAiAuthPrefix: process.env.CUSTOM_AI_AUTH_PREFIX || 'Bearer',
  customAiExtraHeaders: JSON.parse(process.env.CUSTOM_AI_EXTRA_HEADERS || 'null') || undefined,

  // Cross-provider routing and circuit breaker
  aiProviderOrder: configuredProviderOrder.length > 0
    ? configuredProviderOrder
    : ['openrouter', 'gemini', 'groq', 'cerebras', 'pollinations', 'puter', 'custom'],
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS) || 12000,
  aiCircuitFailureThreshold: Number(process.env.AI_CIRCUIT_FAILURE_THRESHOLD) || 2,
  aiCircuitCooldownMs: Number(process.env.AI_CIRCUIT_COOLDOWN_MS) || 30_000,
  aiRateLimitCooldownMs: Number(process.env.AI_RATELIMIT_COOLDOWN_MS) || 60_000,
  aiQuotaCooldownMs: Number(process.env.AI_QUOTA_COOLDOWN_MS) || 5 * 60_000,
  maxTokens: Number(process.env.MAX_TOKENS_DEFAULT) || 512,
  maxTokensTask: {
    routing: Number(process.env.MAX_TOKENS_ROUTING) || 220,
    simpleChat: Number(process.env.MAX_TOKENS_SIMPLE_CHAT) || 512,
    complexChat: Number(process.env.MAX_TOKENS_COMPLEX_CHAT) || 1000,
  },

  // TTS
  // Select language via TTS_LANGUAGE (e.g. id-ID, en-US, ja-JP).
  // TTS_VOICE overrides the language-map voice if set explicitly.
  ttsLanguage: process.env.TTS_LANGUAGE || 'id-ID',
  ttsVoice: process.env.TTS_VOICE || '',
  ttsRate: process.env.TTS_RATE || '+0%',
  ttsPitch: process.env.TTS_PITCH || '+0Hz',
  // TTS_TRANSLATE_ENGLISH (default on): chat/action voice replies are
  // translated to English and spoken with an English voice.
  // Set TTS_TRANSLATE_ENGLISH=false to keep the configured language/voice.
  ttsTranslateEnglish: process.env.TTS_TRANSLATE_ENGLISH !== 'false',

  // Custom OpenAI-compatible TTS (primary). Falls back to Edge TTS on failure.
  // Enable by setting CUSTOM_TTS_BASE_URL + CUSTOM_TTS_MODEL.
  customTtsBaseUrl: process.env.CUSTOM_TTS_BASE_URL || '',
  customTtsApiKey: process.env.CUSTOM_TTS_API_KEY || '',
  customTtsModel: process.env.CUSTOM_TTS_MODEL || '',
  customTtsVoice: process.env.CUSTOM_TTS_VOICE || 'alloy',
  customTtsLanguage: process.env.CUSTOM_TTS_LANGUAGE || process.env.TTS_LANGUAGE || '',
  customTtsResponseFormat: process.env.CUSTOM_TTS_RESPONSE_FORMAT || 'mp3',
  customTtsSpeed: Number(process.env.CUSTOM_TTS_SPEED) || 1,
  customTtsTimeoutMs: Number(process.env.CUSTOM_TTS_TIMEOUT_MS) || 30000,

  // RAG
  maxSearchResults: 5,
  maxScrapeSources: 3,
  maxContentLength: 2000,
  ragTimeoutMs: 30000,

  // Smart Memory
  maxMemoryMessages: 30,
  memoryTtlMs: 2 * 60 * 60 * 1000, // 2 hours
  contextSummaryInterval: 5, // summarize context every N messages

  // Data persistence paths
  dataDir: './data',
  afkFile: './data/afk.json',
  userPrefsFile: './data/user-prefs.json',
  wakeSleepFile: './data/wake-state.json',
  learnedPatternsFile: './data/learned-patterns.json',
  serverSettingsFile: process.env.SERVER_SETTINGS_FILE || './data/server-settings.json',
  remindersDbPath: process.env.DATABASE_PATH || './data/voice-reminders.db',
  legacyRemindersFile: process.env.LEGACY_REMINDERS_FILE || './data/voice-reminders.json',

  // Bot personality
  botName: process.env.BOT_NAME || 'AI Bot',

  // Timezone
  timezone: process.env.TIMEZONE || 'Asia/Bangkok',
};

export default config;
