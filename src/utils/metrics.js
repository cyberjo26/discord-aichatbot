/**
 * Metrics tracking for observability.
 */

const metrics = {
  requests: { total: 0, success: 0, failed: 0 },
  latency: { sum: 0, count: 0, p95: [] },
  providers: {},
  features: {},
};

/**
 * Record a metric.
 * 
 * @param {string} type - Metric type, e.g., 'request'
 * @param {Object} data - Metric data
 */
export function recordMetric(type, data) {
  if (type === 'request') {
    metrics.requests.total++;
    if (data.success) metrics.requests.success++;
    else metrics.requests.failed++;
    
    if (data.latency !== undefined) {
      metrics.latency.sum += data.latency;
      metrics.latency.count++;
      metrics.latency.p95.push(data.latency);
      // Keep only the last 100 entries for p95 calculation
      if (metrics.latency.p95.length > 100) {
        metrics.latency.p95.shift();
      }
    }
  }
}

/**
 * Get current metrics summary.
 * 
 * @returns {Object}
 */
export function getMetrics() {
  const p95Array = [...metrics.latency.p95].sort((a, b) => a - b);
  // Nearest-rank p95: ceil(0.95 * n) - 1 (index 94 for the full 100-entry window)
  const p95Index = p95Array.length ? Math.ceil(0.95 * p95Array.length) - 1 : -1;
  const p95 = p95Index >= 0 ? p95Array[p95Index] : 0;
  
  return {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    requests: metrics.requests,
    avgLatency: metrics.latency.count ? Math.round(metrics.latency.sum / metrics.latency.count) : 0,
    p95Latency: p95,
  };
}

export default { recordMetric, getMetrics };
