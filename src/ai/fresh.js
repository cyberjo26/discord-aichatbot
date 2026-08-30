import { webSearch } from '../rag/search.js';
import { scrapeMultiple } from '../rag/scraper.js';
import { chatCompletion } from '../ai/openrouter.js';
import { buildFreshAnswerPrompt, FRESH_GATE_PROMPT } from '../ai/prompts.js';
import logger from '../utils/logger.js';

/**
 * ─── Fresh-Knowledge Pipeline ─────────────────────────────────────────
 * AI models have a knowledge cutoff (month/year). When a user asks about
 * something that happened after that cutoff, this pipeline replaces the
 * model's stale internal knowledge with live web data using the reasoning
 * chain the product spec describes:
 *
 *   Find information → Compare → Select what's important →
 *   Connect it to the context → Draw a conclusion
 *
 * Stages:
 *   0. GATE      — a cheap classifier decides whether the question needs
 *                  fresh data at all (time-sensitive, post-cutoff, or
 *                  version/price/status queries). Plain evergreen questions
 *                  skip the pipeline entirely.
 *   1. FIND      — web search + scrape top results (reuses the SSRF-hardened
 *                  RAG scraper).
 *   2-5. REASON  — a single structured AI call walks Compare → Select →
 *                  Connect → Conclude and returns the final answer plus the
 *                  sources it used and a confidence flag.
 *
 * Everything is cached (1h, same key as RAG) so repeated questions are free.
 */

const FRESH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const freshCache = new Map(); // normalized query -> { answer, sources, timestamp, confidence }

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of freshCache.entries()) {
    if (now - val.timestamp > FRESH_CACHE_TTL_MS) freshCache.delete(key);
  }
}, FRESH_CACHE_TTL_MS / 2).unref();

// Cheap local pre-filter: obviously time-anchored queries skip the AI gate
// call entirely. Everything ambiguous goes to the classifier.
// Bare "new"/"baru"/"recent" are deliberately excluded — they collide with
// casual chat ("gw baru bangun") far more often than they signal a
// post-cutoff question. Ambiguous cases still reach the AI gate.
const OBVIOUSLY_FRESH_RE = /\b(hari ini|kemarin|kemaren|minggu ini|bulan ini|tahun ini|tahun lalu|terbaru|terkini|berita|sekarang|currently|latest|newest|news|today|yesterday|this (week|month|year)|last (week|month|year)|202[4-9]|20[3-9]\d)\b/i;
// Evergreen chat that clearly needs no lookup at all (fast path skip).
const OBVIOUSLY_STATIC_RE = /^(hai|halo|hello|hi|hey|pagi|siang|sore|malam|makasih|terima kasih|thanks|thank you|oke|ok|baik|siap|mantap)[!. ]*$/i;

function normalizeQuery(query) {
  if (!query || typeof query !== 'string') return '';
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Cheap local time-sensitivity check (no AI call). Used by callers to upgrade
 * a "chat"-classified question to the fresh pipeline when it is obviously
 * anchored to recent time ("hari ini", "terbaru", "2026", ...).
 * @param {string} text
 * @returns {boolean}
 */
export function looksTimeSensitive(text) {
  return OBVIOUSLY_FRESH_RE.test(String(text || ''));
}

/**
 * Stage 0 — decide whether a query needs fresh web data.
 * @param {string} query
 * @returns {Promise<{needsFreshData: boolean, searchQuery: string|null, reason: string}>}
 */
export async function needsFreshData(query) {
  const text = String(query || '').trim();
  if (!text) return { needsFreshData: false, searchQuery: null, reason: 'empty' };

  // Trivial chat never hits the pipeline
  if (OBVIOUSLY_STATIC_RE.test(text)) {
    return { needsFreshData: false, searchQuery: null, reason: 'static-greeting' };
  }

  // Obvious time anchors skip the classifier (saves a routing call)
  if (OBVIOUSLY_FRESH_RE.test(text)) {
    return { needsFreshData: true, searchQuery: text, reason: 'time-anchor' };
  }

  // Ambiguous: let the model classify (falls back to "no" on failure —
  // a stale answer beats a broken one)
  try {
    const response = await chatCompletion(
      [
        { role: 'system', content: FRESH_GATE_PROMPT },
        { role: 'user', content: text },
      ],
      { task: 'routing', temperature: 0, maxTokens: 120 }
    );
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      needsFreshData: Boolean(parsed.needs_fresh_data),
      searchQuery: parsed.search_query || text,
      reason: parsed.needs_fresh_data ? `gate:${parsed.reason || 'classified'}` : 'gate:not-needed',
    };
  } catch (err) {
    logger.debug(`Fresh gate classifier failed, skipping pipeline: ${err.message}`);
    return { needsFreshData: false, searchQuery: null, reason: 'gate-error' };
  }
}

/**
 * Stage 1 — FIND: search the web and scrape the top sources.
 * @returns {Promise<{sources: Array<{title, url, snippet, content}>}>}
 */
async function findInformation(searchQuery) {
  const searchResults = await webSearch(searchQuery);
  if (searchResults.length === 0) return { sources: [] };

  const scraped = await scrapeMultiple(searchResults);
  // Prefer full scraped content; fall back to search snippets so we always
  // have something to reason over.
  const sources = searchResults.map((r) => {
    const full = scraped.find((s) => s.url === r.url);
    return { title: r.title, url: r.url, snippet: r.snippet, content: full ? full.content : r.snippet };
  });
  return { sources };
}

/**
 * Build the search query for /ask-style entry points: the gate runs only when
 * the caller has not already decided freshness.
 */
export async function buildFreshSearchQuery(query) {
  const gate = await needsFreshData(query);
  if (!gate.needsFreshData) return null;
  return gate.searchQuery || query;
}

/**
 * Full fresh-answer pipeline: gate → find → compare → select → connect → conclude.
 *
 * @param {string} query - The user's original question
 * @param {object} [options]
 * @param {string} [options.conversationContext] - Recent conversation summary
 *        used in the CONNECT stage so the answer fits the ongoing chat.
 * @param {boolean} [options.gate=true] - Run the freshness gate. Callers that
 *        already know the question is time-sensitive can pass false.
 * @returns {Promise<{answer: string, sources: Array<{title, url}>, confidence: 'high'|'low', usedFreshData: boolean}>}
 */
export async function freshAnswer(query, { conversationContext = '', gate = true } = {}) {
  const result = {
    answer: '',
    sources: [],
    confidence: 'low',
    usedFreshData: false,
  };

  if (!query || !String(query).trim()) return result;

  // Stage 0: gate (with cache check before AND after — a cached answer for
  // the same question makes the gate itself unnecessary)
  const cacheKey = normalizeQuery(query);
  const cached = freshCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < FRESH_CACHE_TTL_MS) {
    logger.info(`Fresh-answer cache hit for: "${query}"`);
    return { ...cached, usedFreshData: true };
  }

  if (gate) {
    const decision = await needsFreshData(query);
    if (!decision.needsFreshData) {
      return result; // caller falls back to the model's internal knowledge
    }
    query = decision.searchQuery || query;
  }

  // Stage 1: FIND
  const { sources } = await findInformation(query);
  if (sources.length === 0) {
    logger.debug(`Fresh-answer: no web sources for "${query}"`);
    return result; // no fresh data found — fall back
  }

  // Stages 2-5: COMPARE → SELECT → CONNECT → CONCLUDE in one structured call
  const systemPrompt = buildFreshAnswerPrompt(conversationContext);
  const contextBlock = sources
    .map((s, i) => `--- Sumber [${i + 1}]: ${s.title} (${s.url}) ---\n${String(s.content || s.snippet).slice(0, 2000)}`)
    .join('\n\n');

  let parsed;
  try {
    const response = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Pertanyaan user: "${query}"\n\nData web terbaru:\n${contextBlock}` },
      ],
      { task: 'knowledge', temperature: 0.3 }
    );
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`Fresh-answer reasoning failed: ${err.message}`);
    return result;
  }

  const answer = (parsed.answer || '').trim();
  if (!answer) return result;

  // Map the model's selected source indexes (1-based) back to URLs
  const selectedIdx = Array.isArray(parsed.sources_used)
    ? parsed.sources_used.map((n) => Number(n) - 1).filter((i) => i >= 0 && i < sources.length)
    : [];
  const usedSources = (selectedIdx.length > 0 ? selectedIdx : sources.slice(0, 3).map((_, i) => i))
    .map((i) => ({ title: sources[i].title, url: sources[i].url }));

  result.answer = answer;
  result.sources = usedSources;
  result.confidence = parsed.confidence === 'high' ? 'high' : 'low';
  result.usedFreshData = true;

  freshCache.set(cacheKey, { ...result, timestamp: Date.now() });
  logger.info(`Fresh-answer pipeline completed: ${usedSources.length} source(s), confidence=${result.confidence}`);
  return result;
}

export default { freshAnswer, needsFreshData };
