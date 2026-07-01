import fs from 'fs';
import path from 'path';

/**
 * Safely writes data to a JSON file atomically.
 * Prevents file corruption during crashes by writing to a temp file first.
 *
 * @param {string} filepath 
 * @param {any} data 
 */
export function safeWriteJson(filepath, data) {
  const tmpPath = `${filepath}.tmp`;
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    // Write to tmp file
    fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    
    // Rename tmp to actual file (atomic operation on POSIX, nearly atomic on Windows)
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    // Clean up tmp file if rename failed but tmp exists
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {
        // ignore
      }
    }
    throw err;
  }
}

export default { safeWriteJson };
