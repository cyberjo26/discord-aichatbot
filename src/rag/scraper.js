import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Scrape the main text content from a URL.
 *
 * @param {string} url
 * @returns {Promise<string|null>} Extracted text or null on failure
 */
export async function scrapeUrl(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      maxRedirects: 3,
      responseType: 'text',
    });

    const $ = cheerio.load(data);

    // Remove unwanted elements
    $('script, style, nav, footer, header, aside, iframe, noscript, .ad, .ads, .advertisement, [role="banner"], [role="navigation"]').remove();

    // Try to find main content in order of preference
    let text = '';
    const selectors = ['article', 'main', '[role="main"]', '.post-content', '.entry-content', '.article-body', '.content'];

    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0) {
        text = el.text();
        break;
      }
    }

    // Fallback to body
    if (!text) {
      text = $('body').text();
    }

    // Clean up whitespace
    text = text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Truncate
    if (text.length > config.maxContentLength) {
      text = text.slice(0, config.maxContentLength) + '...';
    }

    logger.debug(`Scraped ${url}: ${text.length} chars`);
    return text || null;
  } catch (err) {
    logger.debug(`Failed to scrape ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Scrape multiple URLs in parallel.
 *
 * @param {Array<{title: string, url: string, snippet: string}>} results
 * @param {number} [maxSources]
 * @returns {Promise<Array<{title: string, url: string, content: string}>>}
 */
export async function scrapeMultiple(results, maxSources = config.maxScrapeSources) {
  const toScrape = results.slice(0, maxSources);
  const promises = toScrape.map(async (r) => {
    const content = await scrapeUrl(r.url);
    return content ? { title: r.title, url: r.url, content } : null;
  });

  const settled = await Promise.allSettled(promises);
  const scraped = settled
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);

  logger.debug(`Successfully scraped ${scraped.length}/${toScrape.length} sources`);
  return scraped;
}

export default { scrapeUrl, scrapeMultiple };
