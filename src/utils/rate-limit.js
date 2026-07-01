/**
 * Rate limiting to prevent spam and abuse (User, Guild, Global).
 */

const userLimits = new Map(); // userId -> { count, resetAt }
const guildLimits = new Map(); // guildId -> { count, resetAt }

let activeGlobalRequests = 0;
const MAX_GLOBAL_CONCURRENT = 50;

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_USER_PER_WINDOW = 20;
const MAX_GUILD_PER_WINDOW = 150;

/**
 * Checks rate limits (User, Guild, Global Concurrent).
 * 
 * @param {string} userId - User ID
 * @param {string|null} guildId - Guild ID (if any)
 * @returns {{ allowed: boolean, remaining: number, resetIn?: number, reason?: string }}
 */
export function checkRateLimit(userId, guildId) {
  const now = Date.now();

  // 1. Global Concurrent Limit
  if (activeGlobalRequests >= MAX_GLOBAL_CONCURRENT) {
    return { allowed: false, remaining: 0, resetIn: 5000, reason: 'global_concurrency' };
  }

  // 2. Guild Limit
  if (guildId) {
    let gLimit = guildLimits.get(guildId);
    if (!gLimit || now > gLimit.resetAt) {
      gLimit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      guildLimits.set(guildId, gLimit);
    }
    if (gLimit.count >= MAX_GUILD_PER_WINDOW) {
      return { allowed: false, remaining: 0, resetIn: gLimit.resetAt - now, reason: 'guild_quota' };
    }
    gLimit.count++;
  }

  // 3. User Limit
  let uLimit = userLimits.get(userId);
  if (!uLimit || now > uLimit.resetAt) {
    uLimit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    userLimits.set(userId, uLimit);
  }
  if (uLimit.count >= MAX_USER_PER_WINDOW) {
    return { allowed: false, remaining: 0, resetIn: uLimit.resetAt - now, reason: 'user_quota' };
  }
  uLimit.count++;

  activeGlobalRequests++;
  return { allowed: true, remaining: MAX_USER_PER_WINDOW - uLimit.count };
}

export function releaseRateLimit() {
  if (activeGlobalRequests > 0) activeGlobalRequests--;
}

export function cleanupRateLimits() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, limit] of userLimits.entries()) {
    if (now > limit.resetAt) {
      userLimits.delete(userId);
      cleaned++;
    }
  }
  for (const [guildId, limit] of guildLimits.entries()) {
    if (now > limit.resetAt) {
      guildLimits.delete(guildId);
      cleaned++;
    }
  }
  return cleaned;
}

export default { checkRateLimit, releaseRateLimit, cleanupRateLimits };
