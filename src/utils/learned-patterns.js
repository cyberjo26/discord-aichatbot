import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from './logger.js';
import { safeWriteJson } from './file-utils.js';
import { chatCompletion } from '../ai/openrouter.js';
import { geminiEmbedding } from '../ai/providers/gemini.js';

// Cache query embeddings for frequently asked queries
const queryEmbeddingCache = new Map(); // Max 100 entries, LRU
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCachedEmbedding(query) {
  const key = query.toLowerCase().trim();
  const cached = queryEmbeddingCache.get(key);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.embedding;
  }
  
  const embedding = await geminiEmbedding(query);
  
  // Simple LRU: remove oldest if cache full
  if (queryEmbeddingCache.size >= 100) {
    const firstKey = queryEmbeddingCache.keys().next().value;
    queryEmbeddingCache.delete(firstKey);
  }
  
  queryEmbeddingCache.set(key, { embedding, timestamp: Date.now() });
  return embedding;
}

// Simple text tokenizer
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// Cosine similarity for embedding vectors
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Simple TF-IDF similarity calculation for local pattern retrieval
function calculateTfidfSimilarity(query, patternsList) {
  if (!patternsList || patternsList.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return patternsList.map(p => ({ pattern: p, score: 0 }));
  }

  // Build document tokens for each pattern (trigger + examples)
  const docs = patternsList.map(p => {
    const text = [p.trigger || '', ...(p.examples || [])].join(' ');
    return tokenize(text);
  });

  // Calculate Document Frequency (DF) for each unique token in the query
  const df = {};
  const uniqueQueryTokens = new Set(queryTokens);
  for (const token of uniqueQueryTokens) {
    df[token] = 0;
    for (const doc of docs) {
      if (doc.includes(token)) {
        df[token]++;
      }
    }
  }

  const N = docs.length;
  // Calculate Inverse Document Frequency (IDF)
  const idf = {};
  for (const token of uniqueQueryTokens) {
    idf[token] = Math.log(1 + (N - df[token] + 0.5) / (df[token] + 0.5));
  }

  // Calculate Term Frequency (TF) for query
  const queryTf = {};
  for (const token of queryTokens) {
    queryTf[token] = (queryTf[token] || 0) + 1;
  }

  // Score each pattern
  return patternsList.map((p, idx) => {
    const docTokens = docs[idx];
    const docTf = {};
    for (const token of docTokens) {
      docTf[token] = (docTf[token] || 0) + 1;
    }

    let dot = 0;
    let queryMagSq = 0;
    let docMagSq = 0;

    for (const token of uniqueQueryTokens) {
      const qVal = queryTf[token] * idf[token];
      const dVal = (docTf[token] || 0) * idf[token];
      dot += qVal * dVal;
      queryMagSq += qVal * qVal;
    }

    const uniqueDocTokens = new Set(docTokens);
    for (const token of uniqueDocTokens) {
      // Use query idf if word exists in query, otherwise fallback to a tiny default idf
      const tokenIdf = idf[token] !== undefined ? idf[token] : 0.1;
      const dVal = docTf[token] * tokenIdf;
      docMagSq += dVal * dVal;
    }

    const similarity = (queryMagSq > 0 && docMagSq > 0)
      ? dot / (Math.sqrt(queryMagSq) * Math.sqrt(docMagSq))
      : 0;

    return { pattern: p, score: similarity };
  });
}


/**
 * Self-Learning Pattern System
 *
 * When the AI doesn't understand a user request, it asks for clarification.
 * The user explains, then replies "UPDATE" to teach the bot.
 * The learned pattern is persisted and injected into future AI prompts.
 */

let patterns = [];
let saveTimeout = null;

// Track pending learning sessions per channel
// key: channelId, value: { userId, originalMessage, explanation, timestamp }
const pendingLearns = new Map();

/**
 * Initialize — load patterns from disk
 */
export function initPatterns() {
  try {
    const dir = path.dirname(config.learnedPatternsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(config.learnedPatternsFile)) {
      const raw = fs.readFileSync(config.learnedPatternsFile, 'utf-8');
      const data = JSON.parse(raw);
      patterns = data.patterns || [];
      logger.info(`🧠 Loaded ${patterns.length} learned patterns`);
      
      // Backfill embeddings in the background
      backfillEmbeddings().catch((err) =>
        logger.error(`Backfill embeddings error: ${err.message}`)
      );
    }
  } catch (err) {
    logger.warn(`Failed to load learned patterns: ${err.message}`);
    patterns = [];
  }
}

async function backfillEmbeddings() {
  const missing = patterns.filter((p) => !p.embedding);
  if (missing.length === 0) return;

  logger.info(`🧠 Backfilling embeddings for ${missing.length} existing patterns...`);
  let successCount = 0;
  for (const p of missing) {
    try {
      const textToEmbed = `${p.trigger || ''}. ${p.examples?.join('. ') || ''}`;
      if (textToEmbed.trim()) {
        const embedding = await geminiEmbedding(textToEmbed);
        p.embedding = embedding;
        successCount++;
        scheduleSave();
      }
    } catch (err) {
      logger.warn(`Failed to backfill embedding for pattern "${p.trigger}": ${err.message}`);
    }
  }
  if (successCount > 0) {
    logger.info(`🧠 Successfully backfilled ${successCount} pattern embeddings`);
  }
}

/**
 * Save patterns to disk (debounced)
 */
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const dir = path.dirname(config.learnedPatternsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      safeWriteJson(config.learnedPatternsFile, { patterns, updatedAt: new Date().toISOString() });
      logger.debug(`Learned patterns saved (${patterns.length} total)`);
    } catch (err) {
      logger.error(`Failed to save learned patterns: ${err.message}`);
    }
  }, 3000);
}

/**
 * Start a pending learn session — called when AI asks for clarification
 */
export function startPendingLearn(channelId, userId, originalMessage) {
  pendingLearns.set(channelId, {
    userId,
    originalMessage,
    explanations: [],
    timestamp: Date.now(),
  });
  logger.debug(`Pending learn started in channel ${channelId}`);
}

/**
 * Add explanation to a pending learn session
 */
export function addExplanation(channelId, userId, text) {
  const pending = pendingLearns.get(channelId);
  if (!pending || pending.userId !== userId) return false;

  pending.explanations.push(text);
  pending.timestamp = Date.now();
  return true;
}

/**
 * Check if there's a pending learn session for this channel+user
 */
export function hasPendingLearn(channelId, userId) {
  const pending = pendingLearns.get(channelId);
  if (!pending) return false;
  if (pending.userId !== userId) return false;
  // Expire after 5 minutes
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingLearns.delete(channelId);
    return false;
  }
  return true;
}

/**
 * Get the pending learn session data
 */
export function getPendingLearn(channelId) {
  return pendingLearns.get(channelId) || null;
}

/**
 * Complete learning — AI extracts pattern from the conversation and saves it
 */
export async function completeLearning(channelId, userId) {
  const pending = pendingLearns.get(channelId);
  if (!pending || pending.userId !== userId) return null;

  const conversation = [
    `Pesan awal user: "${pending.originalMessage}"`,
    `Penjelasan user: "${pending.explanations.join(' | ')}"`,
  ].join('\n');

  try {
    const result = await chatCompletion(
      [
        {
          role: 'system',
          content: `Kamu bertugas mengekstrak pattern dari percakapan untuk disimpan sebagai "learned knowledge".

Dari percakapan berikut, ekstrak:
1. "trigger" — kata/frasa kunci yang digunakan user (singkat, 2-5 kata)
2. "meaning" — penjelasan lengkap apa maksud user (1-2 kalimat)
3. "examples" — 2-3 variasi cara user mungkin mengungkapkan hal yang sama

KEMBALIKAN HANYA JSON VALID:
{
  "trigger": "...",
  "meaning": "...",
  "examples": ["...", "..."]
}`,
        },
        { role: 'user', content: conversation },
      ],
      { maxTokens: 300 }
    );

    const cleaned = result
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    let embedding = null;
    try {
      const textToEmbed = `${parsed.trigger || ''}. ${parsed.examples?.join('. ') || ''}`;
      if (textToEmbed.trim()) {
        embedding = await geminiEmbedding(textToEmbed);
        logger.debug(`Generated embedding for pattern: "${parsed.trigger}"`);
      }
    } catch (embErr) {
      logger.warn(`Failed to generate embedding for new pattern: ${embErr.message}`);
    }

    const newPattern = {
      id: patterns.length + 1,
      trigger: parsed.trigger || pending.originalMessage.slice(0, 50),
      meaning: parsed.meaning || pending.explanations.join('. '),
      examples: parsed.examples || [],
      embedding,
      learnedFrom: userId,
      learnedAt: new Date().toISOString(),
      usageCount: 0,
    };

    const MAX_LEARNED_PATTERNS = 500;
    if (patterns.length >= MAX_LEARNED_PATTERNS) {
      // Remove least used pattern
      patterns.sort((a, b) => (a.usageCount || 0) - (b.usageCount || 0));
      patterns.shift();
    }

    patterns.push(newPattern);
    pendingLearns.delete(channelId);
    scheduleSave();

    logger.info(`🧠 New pattern learned: "${newPattern.trigger}" → "${newPattern.meaning}"`);
    return newPattern;
  } catch (err) {
    logger.error(`Failed to extract learning pattern: ${err.message}`);
    pendingLearns.delete(channelId);
    return null;
  }
}

/**
 * Build learned knowledge string for injection into AI prompts.
 * Returns formatted string of all learned patterns.
 */
export async function buildLearnedKnowledge(userQuery) {
  if (patterns.length === 0) return { prompt: '', hasMatch: false };
  if (!userQuery) {
    const lines = patterns.map(
      (p) => `• "${p.trigger}" → ${p.meaning}${p.examples.length > 0 ? ` (variasi: ${p.examples.join(', ')})` : ''}`
    );
    return {
      prompt: `PENGETAHUAN YANG SUDAH DIPELAJARI (dari interaksi sebelumnya):\n${lines.join('\n')}`,
      hasMatch: false,
    };
  }

  let matchedPatterns = [];
  let methodUsed = '';
  let hasMatch = false;

  // Layer 1: Gemini Embeddings API (Semantic Search)
  try {
    const queryEmbedding = await getCachedEmbedding(userQuery);
    // Find all patterns that have embeddings
    const embedPatterns = patterns.filter(p => p.embedding && Array.isArray(p.embedding));
    if (embedPatterns.length > 0) {
      const scored = embedPatterns.map(p => {
        const similarity = cosineSimilarity(queryEmbedding, p.embedding);
        return { pattern: p, score: similarity };
      });
      // Sort by similarity descending
      scored.sort((a, b) => b.score - a.score);
      // Filter by threshold
      const threshold = 0.70;
      matchedPatterns = scored
        .filter(item => item.score >= threshold)
        .slice(0, 2)
        .map(item => item.pattern);
      
      if (matchedPatterns.length > 0) {
        hasMatch = true;
        methodUsed = `Embedding API (top similarity: ${scored[0].score.toFixed(3)})`;
      }
    }
  } catch (err) {
    logger.warn(`Semantic pattern matching failed, falling back to TF-IDF: ${err.message}`);
  }

  // Layer 2: Fallback to Local TF-IDF Matching
  if (matchedPatterns.length === 0) {
    try {
      const scored = calculateTfidfSimilarity(userQuery, patterns);
      scored.sort((a, b) => b.score - a.score);
      const threshold = 0.3; // Simple TF-IDF score threshold
      matchedPatterns = scored
        .filter(item => item.score >= threshold)
        .slice(0, 2)
        .map(item => item.pattern);
      
      if (matchedPatterns.length > 0) {
        hasMatch = true;
        methodUsed = `Local TF-IDF (top score: ${scored[0].score.toFixed(3)})`;
      }
    } catch (err) {
      logger.error(`Local TF-IDF pattern matching failed, falling back to all patterns: ${err.message}`);
    }
  }

  // Layer 3: Fallback to summary instead of all patterns
  if (matchedPatterns.length === 0) {
    return {
      prompt: `BOT SUDAH BELAJAR ${patterns.length} pattern khusus dari user. Jika user bertanya tentang sesuatu yang tidak jelas, tanyakan klarifikasi.`,
      hasMatch: false,
    };
  }

  logger.debug(`🧠 Pattern matching selected ${matchedPatterns.length} patterns using ${methodUsed}`);

  const lines = matchedPatterns.map(
    (p) => `• "${p.trigger}" → ${p.meaning}${p.examples.length > 0 ? ` (variasi: ${p.examples.join(', ')})` : ''}`
  );

  return {
    prompt: `PENGETAHUAN YANG SUDAH DIPELAJARI (dari interaksi sebelumnya):\n${lines.join('\n')}`,
    hasMatch,
  };
}

/**
 * Increment usage count for a pattern (called when AI uses a learned pattern)
 */
export function markPatternUsed(trigger) {
  const pattern = patterns.find(
    (p) => p.trigger.toLowerCase() === trigger.toLowerCase()
  );
  if (pattern) {
    pattern.usageCount++;
    scheduleSave();
  }
}

/**
 * Get all patterns (for debugging)
 */
export function getAllPatterns() {
  return [...patterns];
}

export function forceSavePatterns() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (patterns.length === 0) return;
  safeWriteJson(config.learnedPatternsFile, { patterns, updatedAt: new Date().toISOString() });
}

export default {
  initPatterns,
  startPendingLearn,
  addExplanation,
  hasPendingLearn,
  getPendingLearn,
  completeLearning,
  buildLearnedKnowledge,
  markPatternUsed,
  getAllPatterns,
  forceSavePatterns,
};
