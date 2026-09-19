'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');
const logger = require('../logger');
const { fetchWithTimeout } = require('../http');
const { resolveFeedCandidates } = require('./catalogue');
const { readEffectiveWindow, serviceDayKey } = require('./archive');

const CACHE_FILE = 'gtfs.zip';
const META_FILE = 'gtfs.meta.json';

const cachePath = (name) => path.join(config.gtfs.cacheDir, name);

const readMeta = async () => {
  try {
    return JSON.parse(await fsp.readFile(cachePath(META_FILE), 'utf8'));
  } catch {
    return null;
  }
};

const writeCache = async (buffer, meta) => {
  await fsp.mkdir(config.gtfs.cacheDir, { recursive: true });
  await fsp.writeFile(cachePath(CACHE_FILE), buffer);
  await fsp.writeFile(cachePath(META_FILE), JSON.stringify(meta, null, 2));
};

/** Zip archives start with "PK". An HTML error page does not. */
const looksLikeZip = (buffer) =>
  buffer.length > 1024 && buffer[0] === 0x50 && buffer[1] === 0x4b;

const fetchArchive = async (url) => {
  const response = await fetchWithTimeout(url, {
    timeoutMs: config.gtfs.timeoutMs,
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!looksLikeZip(buffer)) {
    throw new Error(`not a zip archive (${buffer.length} bytes)`);
  }
  return buffer;
};

/**
 * Resolve, download and validate the GTFS archive.
 *
 * Candidates are validated one at a time and rejected on failure, because the
 * archive interleaves complete ~11 MB snapshots with ~6 MB ones that can be
 * missing `shapes.txt` — which would leave the map with no route geometry at
 * all and no error to explain it. `validate` is what actually decides; it is
 * passed the downloaded buffer and should throw if the feed is unusable.
 *
 * Falls back to the last archive written to disk when every candidate fails, so
 * a portal outage degrades to a stale timetable rather than an empty service.
 *
 * When the catalogue supplies names, it has already sorted the candidates by
 * effective date. When it only supplies ids, compare the dates inside every
 * valid archive: upload order is not effective-date order. If nothing is in
 * force, the first valid archive still beats an empty service.
 *
 * @param {{
 *   validate?: (buffer: Buffer) => void,
 *   prefer?: (buffer: Buffer, now: Date) => boolean,
 *   now?: number,
 * }} options
 */
const downloadGtfs = async ({ validate, prefer, now = Date.now() } = {}) => {
  const previous = await readMeta();
  const candidates = await resolveFeedCandidates({ now });
  const errors = [];
  let fallback = null;
  let best = null;
  const today = serviceDayKey(new Date(now));

  for (const candidate of candidates.slice(0, config.gtfs.maxCandidates)) {
    try {
      const buffer = await fetchArchive(candidate.url);
      validate?.(buffer);
      const window = readEffectiveWindow(buffer);

      if (prefer && !prefer(buffer, new Date(now))) {
        logger.info(
          `${candidate.name ?? candidate.url} is not in force today; looking for a better one`,
        );
        fallback ??= { buffer, candidate, window };
        continue;
      }

      // Named entries are already sorted by the catalogue. Bare IDs are only
      // ordered by upload time, so keep the latest effective archive seen.
      if (prefer && !candidate.name) {
        if (!best || (window?.start ?? '') > (best.window?.start ?? '')) {
          best = { buffer, candidate, window };
        }
        continue;
      }

      if (best) {
        if ((window?.start ?? '') > (best.window?.start ?? '')) {
          best = { buffer, candidate, window };
        }
        continue;
      }

      return finish(buffer, candidate, window, previous);
    } catch (error) {
      errors.push(`${candidate.url}: ${error.message}`);
      logger.warn(`candidate rejected (${candidate.url}): ${error.message}`);
    }
  }

  if (best) {
    logger.info(`Using latest in-force GTFS snapshot dated ${best.window?.start ?? today}`);
    return finish(best.buffer, best.candidate, best.window, previous);
  }

  if (fallback) {
    // Nothing was in force — an archive that is merely valid still beats no
    // timetable at all, and /health records which one it settled for.
    const { buffer, candidate, window } = fallback;
    logger.warn(
      `No snapshot is in force today; falling back to ${candidate.name ?? candidate.url}`,
    );
    return finish(buffer, candidate, window, previous);
  }

  const detail = errors.length ? `\n  - ${errors.join('\n  - ')}` : ' (no candidates resolved)';
  logger.error(`Every GTFS candidate failed${detail}`);

  if (config.gtfs.useCache && fs.existsSync(cachePath(CACHE_FILE))) {
    const buffer = await fsp.readFile(cachePath(CACHE_FILE));
    logger.warn(
      `Falling back to cached GTFS archive from ${previous?.fetchedAt ?? 'an unknown date'}`,
    );
    return {
      buffer,
      source: previous?.source ?? 'disk cache',
      snapshot: previous?.snapshot ?? null,
      effectiveStart: previous?.effectiveStart ?? null,
      effectiveEnd: previous?.effectiveEnd ?? null,
      checksum: previous?.checksum ?? null,
      fetchedAt: previous?.fetchedAt ?? null,
      fromCache: true,
    };
  }

  throw new Error(`No usable GTFS feed${detail}`);
};

const finish = async (buffer, candidate, window, previous) => {
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const meta = {
    source: candidate.url,
    snapshot: candidate.name,
    effectiveStart: window?.start ?? null,
    effectiveEnd: window?.end ?? null,
    checksum,
    fetchedAt: new Date().toISOString(),
    bytes: buffer.length,
  };

  if (config.gtfs.useCache) {
    await writeCache(buffer, meta).catch((error) =>
      logger.warn('Could not write GTFS cache:', error.message),
    );
  }

  logger.info(
    `GTFS archive ${previous?.checksum === checksum ? 'unchanged' : 'downloaded'} ` +
      `(${(buffer.length / 1e6).toFixed(1)} MB) from ${candidate.name ?? candidate.url}`,
  );

  return { buffer, ...meta, fromCache: false };
};

module.exports = { downloadGtfs, looksLikeZip };
