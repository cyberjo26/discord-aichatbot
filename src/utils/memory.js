import config from '../config.js';
import logger from './logger.js';
import { chatCompletion } from '../ai/openrouter.js';

/**
 * Smart Context Memory — Enhanced conversation memory with topic tracking.
 *
 * Each user entry has:
 * - messages: [{role, content, timestamp}] — full conversation history
 * - topics: string[] — extracted topics from conversation
 * - contextSummary: string — AI-generated summary of conversation context
 * - lastActive: timestamp
 */
const store = new Map();

/**
 * Get conversation history for a user
 */
export function getHistory(userId) {
  const entry = store.get(userId);
  if (!entry) return [];
  entry.lastActive = Date.now();
  return entry.messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Get full context entry for a user (including topics & summary)
 */
export function getContext(userId) {
  const entry = store.get(userId);
  if (!entry) {
    return {
      messages: [],
      topics: [],
      contextSummary: '',
      lastActive: null,
    };
  }
  entry.lastActive = Date.now();
  return {
    messages: entry.messages.map((m) => ({ role: m.role, content: m.content })),
    topics: [...entry.topics],
    contextSummary: entry.contextSummary || '',
    lastActive: entry.lastActive,
  };
}

/**
 * Add a message to user's conversation history.
 * Automatically extracts topics and periodically generates context summaries.
 */
export function addMessage(userId, role, content) {
  if (!store.has(userId)) {
    store.set(userId, {
      messages: [],
      topics: [],
      contextSummary: '',
      lastActive: Date.now(),
      messageCount: 0,
    });
  }

  const entry = store.get(userId);
  entry.messages.push({ role, content, timestamp: Date.now() });
  entry.lastActive = Date.now();
  entry.messageCount++;

  // Keep only last N messages
  if (entry.messages.length > config.maxMemoryMessages) {
    entry.messages = entry.messages.slice(-config.maxMemoryMessages);
  }

  // Extract topics from user messages
  if (role === 'user') {
    extractTopics(entry, content);
  }

  // Generate context summary periodically
  if (entry.messageCount % config.contextSummaryInterval === 0 && entry.messages.length >= 4) {
    generateContextSummary(userId, entry).catch((err) => {
      logger.debug(`Context summary generation failed: ${err.message}`);
    });
  }
}

/**
 * Extract topics from message content using keyword detection
 */
function extractTopics(entry, content) {
  // Simple keyword-based topic extraction
  const topicPatterns = [
    // Tech topics
    { pattern: /\b(javascript|js|node\.?js|typescript|ts)\b/i, topic: 'JavaScript/Node.js' },
    { pattern: /\b(python|django|flask|fastapi)\b/i, topic: 'Python' },
    { pattern: /\b(react|vue|angular|svelte|next\.?js)\b/i, topic: 'Frontend Framework' },
    { pattern: /\b(backend|server|api|rest|graphql)\b/i, topic: 'Backend Development' },
    { pattern: /\b(database|sql|mysql|postgres|mongodb|redis)\b/i, topic: 'Database' },
    { pattern: /\b(docker|kubernetes|k8s|deploy|hosting|vps|cloud)\b/i, topic: 'DevOps/Deploy' },
    { pattern: /\b(html|css|tailwind|bootstrap|styling)\b/i, topic: 'Web Design' },
    { pattern: /\b(discord|bot|discord\.js)\b/i, topic: 'Discord Bot' },
    { pattern: /\b(ai|machine\s*learning|ml|deep\s*learning|gpt|llm|neural)\b/i, topic: 'AI/ML' },
    { pattern: /\b(git|github|gitlab|version\s*control)\b/i, topic: 'Git/Version Control' },
    { pattern: /\b(linux|ubuntu|terminal|bash|shell|command\s*line)\b/i, topic: 'Linux/CLI' },
    { pattern: /\b(security|hacking|cyber|encrypt|auth)\b/i, topic: 'Keamanan/Security' },
    { pattern: /\b(game|gaming|unity|unreal|godot|minecraft)\b/i, topic: 'Gaming/Gamedev' },
    // Non-tech
    { pattern: /\b(belajar|belajarin|learn|study|tutorial|course)\b/i, topic: 'Belajar' },
    { pattern: /\b(kerja|karir|career|job|interview|lowongan)\b/i, topic: 'Karir' },
    { pattern: /\b(musik|music|lagu|song|spotify)\b/i, topic: 'Musik' },
    { pattern: /\b(film|movie|anime|series|nonton)\b/i, topic: 'Entertainment' },
  ];

  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(content) && !entry.topics.includes(topic)) {
      entry.topics.push(topic);
      // Keep topics manageable
      if (entry.topics.length > 10) {
        entry.topics = entry.topics.slice(-10);
      }
    }
  }
}

/**
 * Generate a context summary using AI
 */
async function generateContextSummary(userId, entry) {
  if (entry.messages.length < 4) return;

  const recentMessages = entry.messages
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  try {
    const summary = await chatCompletion(
      [
        {
          role: 'system',
          content:
            'Kamu bertugas merangkum konteks percakapan. Buat ringkasan SINGKAT (1-2 kalimat) tentang apa yang sedang dibicarakan user, topik yang diminati, dan apa yang sedang mereka kerjakan/pelajari. Jawab HANYA dengan ringkasannya, tanpa kata pengantar.',
        },
        {
          role: 'user',
          content: `Rangkum konteks percakapan ini:\n\n${recentMessages}`,
        },
      ],
      { maxTokens: 150 }
    );

    entry.contextSummary = summary;
    logger.debug(`Context summary updated for user ${userId}: "${summary.slice(0, 80)}..."`);
  } catch {
    // Silently fail — context summary is nice-to-have
  }
}

/**
 * Build context injection string for AI prompt
 */
export function buildContextInjection(userId) {
  const ctx = getContext(userId);
  const parts = [];

  if (ctx.contextSummary) {
    parts.push(`KONTEKS PERCAKAPAN SEBELUMNYA: ${ctx.contextSummary}`);
  }

  if (ctx.topics.length > 0) {
    parts.push(`TOPIK YANG DIMINATI USER: ${ctx.topics.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Clear a user's conversation history
 */
export function clearHistory(userId) {
  store.delete(userId);
}

/**
 * Periodic cleanup of stale conversations
 */
function cleanup() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, entry] of store) {
    if (now - entry.lastActive > config.memoryTtlMs) {
      store.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(`Memory cleanup: removed ${cleaned} stale conversations`);
  }
}

// Run cleanup every 10 minutes
setInterval(cleanup, 10 * 60 * 1000);

export default { getHistory, getContext, addMessage, buildContextInjection, clearHistory };
