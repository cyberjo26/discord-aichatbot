import { webSearch } from './search.js';
import { scrapeMultiple } from './scraper.js';
import { chatCompletion } from '../ai/openrouter.js';
import { buildRagPrompt } from '../ai/prompts.js';
import config from '../config.js';
import logger from '../utils/logger.js';

// Cache RAG results for frequently asked questions
const ragCache = new Map(); // query key -> { answer, sources, timestamp }
const RAG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of ragCache.entries()) {
    if (now - val.timestamp > RAG_CACHE_TTL_MS) {
      ragCache.delete(key);
    }
  }
}, RAG_CACHE_TTL_MS / 2).unref();

/**
 * Full RAG pipeline:
 * 1. Search web for query
 * 2. Scrape top results
 * 3. Build context
 * 4. Generate AI answer with sources
 *
 * @param {string} query
 * @returns {Promise<{answer: string, sources: Array<{title: string, url: string}>}>}
 */
export async function ragPipeline(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached = ragCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < RAG_CACHE_TTL_MS) {
    logger.info(`RAG cache hit for: "${query}"`);
    return cached;
  }

  logger.info(`RAG pipeline started: "${query}"`);
  const startTime = Date.now();

  // Step 1: Search
  const searchResults = await webSearch(query);

  if (searchResults.length === 0) {
    logger.warn('No search results, falling back to direct AI');
    // Fallback: answer without web context
    const answer = await chatCompletion([
      { role: 'system', content: buildRagPrompt('Tidak ada konteks web yang tersedia.', []) },
      { role: 'user', content: query },
    ]);
    return { answer, sources: [] };
  }

  // Step 2: Scrape top results
  const scraped = await scrapeMultiple(searchResults);

  // Build context from scraped content + snippets as fallback
  let context = '';
  const sources = [];

  if (scraped.length > 0) {
    context = scraped
      .map((s, i) => `--- Sumber [${i + 1}]: ${s.title} ---\n${s.content}`)
      .join('\n\n');
    sources.push(...scraped.map((s) => ({ title: s.title, url: s.url })));
  } else {
    // Use search snippets as fallback context
    context = searchResults
      .map((s, i) => `--- Sumber [${i + 1}]: ${s.title} ---\n${s.snippet}`)
      .join('\n\n');
    sources.push(...searchResults.map((s) => ({ title: s.title, url: s.url })));
  }

  // Step 3: Generate answer with RAG prompt
  const systemPrompt = buildRagPrompt(context, sources);
  const answer = await chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: query },
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.success(`RAG pipeline completed in ${elapsed}s`);

  const result = { answer, sources, timestamp: Date.now() };
  ragCache.set(cacheKey, result);

  return result;
}

export default { ragPipeline };
