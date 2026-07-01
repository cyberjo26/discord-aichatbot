import 'dotenv/config';

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

const configuredProviderOrder = envList('AI_PROVIDER_ORDER', ['openrouter', 'gemini', 'groq', 'cerebras', 'pollinations'])
  .filter((name) => name === 'openrouter' || name === 'gemini' || name === 'groq' || name === 'cerebras' || name === 'pollinations');

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

  // Cross-provider routing and circuit breaker
  aiProviderOrder: configuredProviderOrder.length > 0
    ? configuredProviderOrder
    : ['openrouter', 'gemini', 'groq', 'cerebras', 'pollinations'],
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS) || 12000,
  aiCircuitFailureThreshold: 2,
  aiCircuitCooldownMs: 30_000,
  aiRateLimitCooldownMs: 60_000,
  aiQuotaCooldownMs: 5 * 60_000,
  maxTokens: 512,

  // TTS
  ttsVoice: process.env.TTS_VOICE || 'id-ID-ArdiNeural',
  ttsRate: process.env.TTS_RATE || '+0%',
  ttsPitch: process.env.TTS_PITCH || '+0Hz',

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
