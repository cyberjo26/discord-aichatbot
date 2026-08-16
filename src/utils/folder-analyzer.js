import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Folder Analysis & Safe Quarantine Engine with Custom Ignore Patterns
 */
export class FolderAnalysisEngine {
  constructor(options = {}) {
    this.quarantineDir = options.quarantineDir || path.resolve('./data/quarantine');
    this.dbPath = options.dbPath || path.resolve('./data/quarantine/metadata.json');
    this.excludeList = new Set(options.excludeList || []);
    this.ignorePatterns = new Set(options.ignorePatterns || [
      'node_modules',
      '.git',
      '.vscode',
      '.zcode',
      '.agents',
      '$Recycle.Bin',
      'System Volume Information'
    ]);
    this.quarantineRetentionDays = options.quarantineRetentionDays || 30;
    this.initStorage();
  }

  initStorage() {
    if (!fs.existsSync(this.quarantineDir)) {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
    }
    if (!fs.existsSync(this.dbPath)) {
      fs.writeFileSync(
        this.dbPath,
        JSON.stringify({ items: [], exclusions: [], ignorePatterns: Array.from(this.ignorePatterns) }, null, 2)
      );
    } else {
      try {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        if (Array.isArray(data.exclusions)) {
          data.exclusions.forEach((e) => this.excludeList.add(path.resolve(e)));
        }
        if (Array.isArray(data.ignorePatterns)) {
          data.ignorePatterns.forEach((p) => this.ignorePatterns.add(p));
        }
      } catch {
        // use defaults
      }
    }
  }

  saveMetadata(data) {
    fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
  }

  getMetadata() {
    try {
      return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch {
      return { items: [], exclusions: [], ignorePatterns: [] };
    }
  }

  addIgnorePattern(pattern) {
    if (!pattern) return;
    this.ignorePatterns.add(pattern);
    const meta = this.getMetadata();
    if (!meta.ignorePatterns) meta.ignorePatterns = [];
    if (!meta.ignorePatterns.includes(pattern)) {
      meta.ignorePatterns.push(pattern);
      this.saveMetadata(meta);
    }
  }

  loadPcMonIgnore(dirPath) {
    const ignoreFile = path.join(dirPath, '.pcmonignore');
    if (fs.existsSync(ignoreFile)) {
      try {
        const lines = fs
          .readFileSync(ignoreFile, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        lines.forEach((l) => this.ignorePatterns.add(l));
      } catch {
        // ignore error
      }
    }
  }

  isIgnored(targetPath, baseName) {
    if (this.excludeList.has(path.resolve(targetPath))) return true;
    if (targetPath.startsWith(this.quarantineDir)) return true;

    for (const pattern of this.ignorePatterns) {
      if (baseName === pattern || targetPath.includes(path.sep + pattern + path.sep) || targetPath.endsWith(path.sep + pattern)) {
        return true;
      }
    }
    return false;
  }

  addExclusion(folderPath) {
    const resolved = path.resolve(folderPath);
    this.excludeList.add(resolved);
    const meta = this.getMetadata();
    if (!meta.exclusions) meta.exclusions = [];
    if (!meta.exclusions.includes(resolved)) {
      meta.exclusions.push(resolved);
      this.saveMetadata(meta);
    }
  }

  removeExclusion(folderPath) {
    const resolved = path.resolve(folderPath);
    this.excludeList.delete(resolved);
    const meta = this.getMetadata();
    meta.exclusions = (meta.exclusions || []).filter((p) => p !== resolved);
    this.saveMetadata(meta);
  }

  hashFile(filePath, sampleOnly = true) {
    try {
      const stat = fs.statSync(filePath);
      const hash = crypto.createHash('sha256');

      if (!sampleOnly || stat.size <= 8192) {
        const buffer = fs.readFileSync(filePath);
        hash.update(buffer);
      } else {
        const fd = fs.openSync(filePath, 'r');
        const buf1 = Buffer.alloc(4096);
        const buf2 = Buffer.alloc(4096);
        fs.readSync(fd, buf1, 0, 4096, 0);
        fs.readSync(fd, buf2, 0, 4096, stat.size - 4096);
        fs.closeSync(fd);
        hash.update(buf1);
        hash.update(buf2);
        hash.update(String(stat.size));
      }
      return hash.digest('hex');
    } catch {
      return null;
    }
  }

  computeFolderFingerprint(dirPath) {
    const fileHashes = [];
    const walk = (d) => {
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (this.isIgnored(full, entry.name)) continue;

        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const h = this.hashFile(full);
          if (h) fileHashes.push(h);
        }
      }
    };
    walk(dirPath);
    if (fileHashes.length === 0) return null;
    fileHashes.sort();
    return crypto.createHash('sha256').update(fileHashes.join(':')).digest('hex');
  }

  scan(rootPath, { staleDays = 60 } = {}) {
    const resolvedRoot = path.resolve(rootPath);
    this.loadPcMonIgnore(resolvedRoot);

    const results = {
      duplicates: [],
      corrupted: [],
      stale: [],
      totalScanned: 0
    };

    if (!fs.existsSync(resolvedRoot)) return results;

    const folderFingerprints = new Map();
    const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const analyzeFolder = (dir) => {
      const baseName = path.basename(dir);
      if (this.isIgnored(dir, baseName)) return;

      results.totalScanned++;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        results.corrupted.push({ path: dir, reason: 'UNREADABLE_DIRECTORY' });
        return;
      }

      let fileCount = 0;
      let totalSize = 0;
      let staleCount = 0;
      let corruptFiles = 0;
      let latestAccess = 0;

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (this.isIgnored(fullPath, entry.name)) continue;

        if (entry.isDirectory()) {
          analyzeFolder(fullPath);
        } else if (entry.isFile()) {
          fileCount++;
          try {
            const stat = fs.statSync(fullPath);
            totalSize += stat.size;
            latestAccess = Math.max(latestAccess, stat.atimeMs || stat.mtimeMs);
            if (now - (stat.atimeMs || stat.mtimeMs) > staleThresholdMs) {
              staleCount++;
            }
          } catch {
            corruptFiles++;
          }
        }
      }

      if (corruptFiles > 0) {
        results.corrupted.push({
          path: dir,
          affectedFiles: corruptFiles,
          category: 'corrupted'
        });
      }

      if (fileCount > 0 && staleCount === fileCount) {
        results.stale.push({
          path: dir,
          sizeBytes: totalSize,
          affectedFiles: fileCount,
          lastAccessed: new Date(latestAccess).toISOString(),
          category: 'stale'
        });
      }

      if (fileCount > 0) {
        const fp = this.computeFolderFingerprint(dir);
        if (fp) {
          if (folderFingerprints.has(fp)) {
            results.duplicates.push({
              originalPath: folderFingerprints.get(fp),
              duplicatePath: dir,
              sizeBytes: totalSize,
              category: 'duplicate'
            });
          } else {
            folderFingerprints.set(fp, dir);
          }
        }
      }
    };

    analyzeFolder(resolvedRoot);
    return results;
  }

  quarantine(targetPath) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Target path not found: ${resolved}`);
    }

    const id = crypto.randomUUID();
    const dest = path.join(this.quarantineDir, id);

    fs.renameSync(resolved, dest);

    const record = {
      id,
      originalPath: resolved,
      quarantinePath: dest,
      quarantinedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.quarantineRetentionDays * 24 * 60 * 60 * 1000).toISOString()
    };

    const meta = this.getMetadata();
    if (!meta.items) meta.items = [];
    meta.items.push(record);
    this.saveMetadata(meta);

    return record;
  }

  restore(id) {
    const meta = this.getMetadata();
    const itemIndex = (meta.items || []).findIndex((i) => i.id === id);
    if (itemIndex === -1) {
      throw new Error(`Quarantine record ${id} not found.`);
    }

    const item = meta.items[itemIndex];
    if (!fs.existsSync(item.quarantinePath)) {
      throw new Error(`Quarantine payload missing on disk: ${item.quarantinePath}`);
    }

    const parentDir = path.dirname(item.originalPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.renameSync(item.quarantinePath, item.originalPath);
    meta.items.splice(itemIndex, 1);
    this.saveMetadata(meta);

    return item;
  }

  purgeExpired() {
    const meta = this.getMetadata();
    const now = Date.now();
    const remaining = [];
    const purged = [];

    for (const item of meta.items || []) {
      if (new Date(item.expiresAt).getTime() <= now) {
        try {
          if (fs.existsSync(item.quarantinePath)) {
            fs.rmSync(item.quarantinePath, { recursive: true, force: true });
          }
          purged.push(item);
        } catch {
          remaining.push(item);
        }
      } else {
        remaining.push(item);
      }
    }

    meta.items = remaining;
    this.saveMetadata(meta);
    return purged;
  }
}

export default FolderAnalysisEngine;
