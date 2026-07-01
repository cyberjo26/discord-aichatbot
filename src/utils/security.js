import dns from 'dns';
import http from 'http';
import https from 'https';

/**
 * Checks if an IP is private or restricted.
 */
function isPrivateIP(ip) {
  // IPv4 mappings and actual IPv6 loopbacks/private
  if (ip === '::1') return true;
  if (ip.startsWith('fc00:') || ip.startsWith('fd')) return true; // Unique Local Address
  if (ip.startsWith('fe80:')) return true; // Link-local
  if (ip.startsWith('::ffff:')) ip = ip.split(':').pop();

  // IPv4 checks
  if (ip === '169.254.169.254') return true;
  if (ip === '0.0.0.0' || ip === '255.255.255.255') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return true;
  if (ip.startsWith('192.168.')) return true;

  return false;
}

/**
 * Checks if a URL is safe to fetch (prevents SSRF via DNS resolution).
 *
 * @param {string} urlString
 * @returns {Promise<boolean>}
 */
export async function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    
    const hostname = parsed.hostname;
    
    // Quick IP check before DNS
    if (/^[0-9\.]+$/.test(hostname) || hostname.includes(':')) {
      if (isPrivateIP(hostname.replace(/\[|\]/g, ''))) return false;
    }

    try {
      const { address } = await dns.promises.lookup(hostname);
      if (isPrivateIP(address)) return false;
    } catch (e) {
      return false; // Cannot resolve, deny
    }
    
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Custom DNS lookup for HTTP(S) Agents to prevent DNS rebinding.
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIP(address)) {
      return callback(new Error(`SSRF blocked: Resolved to restricted IP ${address}`));
    }
    callback(null, address, family);
  });
}

export const safeHttpAgent = new http.Agent({ lookup: safeLookup });
export const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

export default { isSafeUrl, safeHttpAgent, safeHttpsAgent };
