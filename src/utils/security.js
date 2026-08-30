import dns from 'dns';
import http from 'http';
import https from 'https';

/**
 * Checks if an IP is private or restricted.
 */
function isPrivateIP(ip) {
  if (typeof ip !== 'string') return false;

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
    if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
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
 *
 * Node's `dns.lookup` callback signature depends on `options.all`:
 *   - all:false (default) → (err, address: string, family)
 *   - all:true             → (err, addresses: Array<{address, family}>, undefined)
 * When `all:true` is in effect, `address` is an array, and calling
 * `isPrivateIP(array)` crashed with "ip.startsWith is not a function".
 * We handle both shapes defensively.
 */
function safeLookup(hostname, options, callback) {
  try {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);

      if (Array.isArray(address)) {
        // `all:true` path: address is [{address, family}, ...].
        for (const entry of address) {
          const ipAddr = entry && typeof entry === 'object' ? entry.address : entry;
          if (isPrivateIP(ipAddr)) {
            return callback(new Error(`SSRF blocked: Resolved to restricted IP ${ipAddr}`));
          }
        }
      } else if (isPrivateIP(address)) {
        return callback(new Error(`SSRF blocked: Resolved to restricted IP ${address}`));
      }

      callback(null, address, family);
    });
  } catch (err) {
    // Never let a lookup validation error crash the process.
    callback(err);
  }
}

export const safeHttpAgent = new http.Agent({ lookup: safeLookup });
export const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

export default { isSafeUrl, safeHttpAgent, safeHttpsAgent };
