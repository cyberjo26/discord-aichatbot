import logger from './logger.js';

/**
 * Executes a promise-returning function with exponential backoff retry logic.
 * 
 * @param {Function} fn - The function to execute.
 * @param {number} maxRetries - Maximum number of retries.
 * @param {number} delayMs - Initial delay in milliseconds.
 * @returns {Promise<any>}
 */
export async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries || (error.retryable !== undefined && !error.retryable)) {
        throw error;
      }
      
      const delay = delayMs * Math.pow(2, attempt - 1); // Exponential backoff
      logger.debug(`Retry attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export default { withRetry };
