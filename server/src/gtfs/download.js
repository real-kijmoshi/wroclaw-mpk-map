'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');
const logger = require('../logger');
const { fetchWithTimeout, tryEachSource } = require('../http');

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

/** A GTFS archive always contains at least these tables. */
const looksLikeGtfs = (buffer) =>
  buffer.length > 1024 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"

/**
 * Download the GTFS archive, trying every configured source in order.
 *
 * Falls back to the last archive written to disk when every source fails, so a
 * portal outage degrades to stale timetables instead of an empty service.
 *
 * @returns {Promise<{ buffer: Buffer, source: string, checksum: string, fetchedAt: string, fromCache: boolean }>}
 */
const downloadGtfs = async () => {
  const previous = await readMeta();

  try {
    const { url, value } = await tryEachSource(
      config.gtfs.sources,
      async (candidate) => {
        const response = await fetchWithTimeout(candidate, {
          timeoutMs: config.gtfs.timeoutMs,
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!looksLikeGtfs(buffer)) {
          throw new Error(`response is not a zip archive (${buffer.length} bytes)`);
        }
        return buffer;
      },
      { label: 'GTFS' },
    );

    const checksum = crypto.createHash('sha256').update(value).digest('hex');
    const meta = { source: url, checksum, fetchedAt: new Date().toISOString(), bytes: value.length };

    if (config.gtfs.useCache) {
      await writeCache(value, meta).catch((error) =>
        logger.warn('Could not write GTFS cache:', error.message),
      );
    }

    if (previous?.checksum === checksum) {
      logger.info(`GTFS archive unchanged (${(value.length / 1e6).toFixed(1)} MB) from ${url}`);
    } else {
      logger.info(`GTFS archive downloaded (${(value.length / 1e6).toFixed(1)} MB) from ${url}`);
    }

    return { buffer: value, ...meta, fromCache: false };
  } catch (error) {
    logger.error('GTFS download failed:', error.message);

    if (config.gtfs.useCache && fs.existsSync(cachePath(CACHE_FILE))) {
      const buffer = await fsp.readFile(cachePath(CACHE_FILE));
      logger.warn(
        `Falling back to cached GTFS archive from ${previous?.fetchedAt ?? 'an unknown date'}`,
      );
      return {
        buffer,
        source: previous?.source ?? 'disk cache',
        checksum: previous?.checksum ?? null,
        fetchedAt: previous?.fetchedAt ?? null,
        fromCache: true,
      };
    }

    throw error;
  }
};

module.exports = { downloadGtfs };
