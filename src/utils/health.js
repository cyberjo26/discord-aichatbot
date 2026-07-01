import { getAiStats } from '../ai/router.js';
import { openReminderStore } from './reminder-store.js';

/**
 * Perform a health check of critical services.
 * 
 * @returns {Promise<Object>}
 */
export async function healthCheck() {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {},
  };
  
  // Check AI providers
  try {
    const aiStats = getAiStats();
    health.checks.ai = aiStats;
    
    // Check if all configured providers are circuit open
    const configuredProviders = Object.values(aiStats).filter(s => s.isConfigured);
    const activeCount = configuredProviders.length;
    const closedCount = configuredProviders.filter(s => s.circuitOpen).length;
    
    if (activeCount > 0 && closedCount === activeCount) {
      health.checks.aiStatus = 'unhealthy (all circuits open)';
      health.status = 'degraded';
    } else {
      health.checks.aiStatus = 'healthy';
    }
  } catch (err) {
    health.checks.aiStatus = 'error';
    health.status = 'degraded';
  }
  
  // Check database
  try {
    const db = openReminderStore();
    db.prepare('SELECT 1').get();
    health.checks.database = 'healthy';
  } catch {
    health.checks.database = 'unhealthy';
    health.status = 'degraded';
  }
  
  return health;
}

export default { healthCheck };
