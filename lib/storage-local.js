import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// For a single local process only. Vercel never falls back to this backend.
export function createLocalBackend(directory = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url))) {
  const file = join(directory, 'serverless-local.json');
  mkdirSync(dirname(file), { recursive: true });
  let records = {};
  try { records = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function persist() {
    for (const [key, entry] of Object.entries(records)) if (entry.expiresAt <= Date.now()) delete records[key];
    writeFileSync(file + '.tmp', JSON.stringify(records)); renameSync(file + '.tmp', file);
  }
  function read(key) { const entry = records[key]; return entry && entry.expiresAt > Date.now() ? entry.value : null; }
  function put(key, value, ttl) { records[key] = { value, expiresAt: Date.now() + ttl * 1000 }; persist(); }
  return {
    async read(key) { return read(key); },
    async create(key, value, ttl) { if (read(key) !== null) return false; put(key, value, ttl); return true; },
    async put(key, value, ttl) { put(key, value, ttl); },
    async compare(key, before, after, ttl) {
      const current = read(key); if (current === null) return -1; if (current !== before) return 0;
      if (after === '') { delete records[key]; persist(); }
      else if (ttl === 'KEEP') { records[key].value = after; persist(); }
      else put(key, after, ttl);
      return 1;
    },
  };
}
