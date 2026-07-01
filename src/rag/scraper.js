import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../config.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/network.js';
import { isSafeUrl, safeHttpAgent, safeHttpsAgent } from '../utils/security.js';

/**
 * Scrape the main text content from a URL.
 *
 * @param {string} url
 * @returns {Promise<string|null>} Extracted text or null on failure
 */
export async function scrapeUrl(initialUrl) {
  if (!(await isSafeUrl(initialUrl))) {
    logger.warn(`SSRF Prevention: Blocked unsafe URL ${initialUrl}`);
    return null;
  }

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
    
    try {
      let currentUrl = initialUrl;
      let response;
      
      // Handle redirects manually to validate each step
      for (let i = 0; i < 3; i++) {
        response = await axios.get(currentUrl, {
          timeout: 5000,
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html, text/plain',
          },
          maxRedirects: 0, // Disable auto redirects
          responseType: 'text',
          validateStatus: (status) => status >= 200 && status < 400,
          maxContentLength: 5 * 1024 * 1024, // Max 5MB
          httpAgent: safeHttpAgent,
          httpsAgent: safeHttpsAgent,
        });
        
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          currentUrl = new URL(response.headers.location, currentUrl).href;
          if (!(await isSafeUrl(currentUrl))) {
            throw new Error(`Unsafe redirect blocked: ${currentUrl}`);
          }
          continue;
        }
        break;
      }
      
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        throw new Error(`Invalid content type: ${contentType}`);
      }
            
      const $ = cheerio.load(response.data);

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

    logger.debug(`Scraped ${initialUrl}: ${text.length} chars`);
    return text || null;
    } catch (err) {
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }, 2, 500).catch(err => {
    logger.debug(`Failed to scrape ${initialUrl}: ${err.message}`);
    return null;
  });
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
