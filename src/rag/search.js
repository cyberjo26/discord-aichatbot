import { tavily } from '@tavily/core';
import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape';
import axios from 'axios';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Search with automatic fallback chain:
 * 1. Tavily Search API (if API key provided — best for RAG)
 * 2. Wikipedia API (always reliable for factual queries)
 * 3. DuckDuckGo (can get rate-limited)
 *
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function webSearch(query, maxResults = config.maxSearchResults) {
  // 1. Try Tavily first if API key exists (best for RAG)
  if (config.tavilyApiKey) {
    const tavilyResults = await searchTavily(query, maxResults);
    if (tavilyResults.length > 0) return tavilyResults;
  }

  // 2. Wikipedia — extremely reliable for factual questions
  const [wikiResults, ddgResults] = await Promise.all([
    searchWikipedia(query, Math.min(maxResults, 3)),
    searchDuckDuckGo(query, maxResults),
  ]);

  // Merge: wiki first (more reliable), then DDG
  const combined = [...wikiResults];
  const wikiUrls = new Set(wikiResults.map((r) => r.url));
  for (const r of ddgResults) {
    if (!wikiUrls.has(r.url)) combined.push(r);
  }

  if (combined.length > 0) {
    return combined.slice(0, maxResults);
  }

  logger.warn('All search methods returned no results');
  return [];
}

// ─── Tavily Search API (optimized for RAG) ─────────────────────────

async function searchTavily(query, maxResults) {
  try {
    logger.debug(`Tavily Search: "${query}"`);

    const tvly = tavily({ apiKey: config.tavilyApiKey });

    const response = await tvly.search(query, {
      maxResults,
      searchDepth: 'basic',
      includeAnswer: false,
    });

    if (!response?.results?.length) return [];

    const results = response.results
      .filter((r) => r.title && r.url)
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content || r.title,
      }));

    logger.debug(`Tavily found ${results.length} results`);
    return results;
  } catch (err) {
    logger.warn(`Tavily Search failed: ${err.message}`);
    return [];
  }
}

// ─── Wikipedia API ─────────────────────────────────────────────────

async function searchWikipedia(query, maxResults) {
  try {
    const lang = 'id';
    const baseUrl = `https://${lang}.wikipedia.org/w/api.php`;

    logger.debug(`Wikipedia (${lang}): "${query}"`);

    const { data } = await axios.get(baseUrl, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: maxResults,
        srprop: 'snippet',
        format: 'json',
        utf8: 1,
      },
      headers: {
        'User-Agent': 'DiscordAIBot/1.0 (Discord Bot; educational)',
      },
      timeout: 8000,
    });

    if (!data?.query?.search?.length) {
      // If Indonesian Wikipedia returns nothing, try English
      return searchWikipediaLang(query, maxResults, 'en');
    }

    const results = data.query.search.map((item) => ({
      title: item.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: item.snippet.replace(/<\/?[^>]+(>|$)/g, '').trim(),
    }));

    logger.debug(`Wikipedia (${lang}) found ${results.length} results`);
    return results;
  } catch (err) {
    logger.warn(`Wikipedia search failed: ${err.message}`);
    return [];
  }
}

async function searchWikipediaLang(query, maxResults, lang) {
  try {
    const { data } = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: maxResults,
        srprop: 'snippet',
        format: 'json',
        utf8: 1,
      },
      headers: {
        'User-Agent': 'DiscordAIBot/1.0 (Discord Bot; educational)',
      },
      timeout: 8000,
    });

    if (!data?.query?.search?.length) return [];

    return data.query.search.map((item) => ({
      title: item.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: item.snippet.replace(/<\/?[^>]+(>|$)/g, '').trim(),
    }));
  } catch {
    return [];
  }
}

// ─── DuckDuckGo ────────────────────────────────────────────────────

async function searchDuckDuckGo(query, maxResults) {
  try {
    logger.debug(`DDG search: "${query}"`);

    const results = await ddgSearch(query, {
      safeSearch: SafeSearchType.MODERATE,
    });

    if (!results?.results?.length) return [];

    return results.results
      .filter((r) => r.title && r.url && r.description)
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
      }));
  } catch (err) {
    logger.debug(`DDG failed: ${err.message}`);
    return [];
  }
}

export default { webSearch };
