/**
 * codepend — derived-session cache.
 *
 * A cold scan reads ~4.6 GB. A warm scan should read nothing. The cache maps
 * `path → {size, mtimeMs, session}` and is invalidated whenever the file changes or the parser
 * changes. It is pure convenience: every operation swallows its own errors, because a broken or
 * unwritable cache must never break a run.
 *
 * Location: `$XDG_CACHE_HOME/codepend` (default `~/.cache/codepend`), per docs/DATA-FORMATS.md §7.
 * Override with `CODEPEND_CACHE_DIR`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARSER_VERSION } from './normalize.js';

/** Bumped by PARSER_VERSION; a scanner change invalidates every entry. */
export const CACHE_SCHEMA = `v${PARSER_VERSION}`;

/** @returns {string} absolute path to the codepend cache directory */
export function cacheDir() {
  if (process.env.CODEPEND_CACHE_DIR) return path.resolve(process.env.CODEPEND_CACHE_DIR);
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.startsWith('/') ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'codepend');
}

/** @param {string} [dir] @returns {string} */
export function cacheFile(dir = cacheDir()) {
  return path.join(dir, `scan-${CACHE_SCHEMA}.json`);
}

/**
 * @typedef {{size:number, mtimeMs:number, session:object|null}} CacheEntry
 * @typedef {{
 *   dir: string, file: string, enabled: boolean, hits: number, misses: number,
 *   get(path: string, stat: {size:number,mtimeMs:number}): object|null|undefined,
 *   set(path: string, stat: {size:number,mtimeMs:number}, session: object|null): void,
 *   save(seenPaths?: Set<string>): Promise<boolean>,
 * }} Cache
 */

/**
 * Load the cache from disk. Never throws.
 * @param {{enabled?: boolean, dir?: string}} [opts]
 * @returns {Promise<Cache>}
 */
export async function openCache(opts = {}) {
  const enabled = opts.enabled !== false;
  const dir = opts.dir ? path.resolve(opts.dir) : cacheDir();
  const file = cacheFile(dir);
  /** @type {Record<string, CacheEntry>} */
  let entries = Object.create(null);
  let dirty = false;

  if (enabled) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === CACHE_SCHEMA && parsed.entries) entries = parsed.entries;
    } catch {
      /* cold cache, corrupt cache, unreadable cache — all the same: start empty */
    }
  }

  return {
    dir,
    file,
    enabled,
    hits: 0,
    misses: 0,

    /**
     * @returns {object|null|undefined} the cached Session (may legitimately be `null` for a
     *   skipped file), or `undefined` on a miss.
     */
    get(p, stat) {
      if (!enabled) return undefined;
      const e = entries[p];
      // mtime alone is not a proxy for content (docs §7): match size AND mtime.
      if (!e || e.size !== stat.size || e.mtimeMs !== stat.mtimeMs) {
        this.misses++;
        return undefined;
      }
      this.hits++;
      return e.session;
    },

    set(p, stat, session) {
      if (!enabled) return;
      entries[p] = { size: stat.size, mtimeMs: stat.mtimeMs, session };
      dirty = true;
    },

    /**
     * Persist. Entries for files not in `seenPaths` are pruned so the cache cannot grow forever.
     * @param {Set<string>} [seenPaths]
     * @returns {Promise<boolean>} true if written
     */
    async save(seenPaths) {
      if (!enabled) return false;
      if (seenPaths) {
        for (const k of Object.keys(entries)) {
          if (!seenPaths.has(k)) {
            delete entries[k];
            dirty = true;
          }
        }
      }
      if (!dirty) return false;
      try {
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ schema: CACHE_SCHEMA, entries }), 'utf8');
        await fs.rename(tmp, file); // atomic: a killed run never leaves a half-written cache
        dirty = false;
        await pruneOldVersions(dir, path.basename(file));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A parser bump renames the cache file; the superseded ones are dead weight. Never throws. */
async function pruneOldVersions(dir, keep) {
  try {
    for (const name of await fs.readdir(dir)) {
      if (name === keep) continue;
      if (/^scan-v\d+\.json(\.\d+\.tmp)?$/.test(name)) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Delete the on-disk cache. Never throws.
 * @param {string} [dir]
 * @returns {Promise<boolean>}
 */
export async function clearCache(dir = cacheDir()) {
  try {
    await fs.rm(cacheFile(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}
