'use strict';

/**
 * A fixed-window per-client request limit.
 *
 * The API is public, unauthenticated and CORS-open, and its most expensive
 * endpoints (`/shapes/:line`, `/stop/:id/departures`) are a single GET away —
 * so one script can pin the process while the timetable index is holding
 * several hundred megabytes. This is the floor that stops that, not a quota:
 * real clients are nowhere near it.
 *
 * Deliberately in-memory and dependency-free. The service is a single Node
 * process with no database (see the deploy notes in README), so a shared store
 * would be infrastructure this project does not otherwise have; per-instance
 * counting is the honest match for how it runs. It follows that a multi-instance
 * deployment limits per instance.
 *
 * There is no sweeper timer on purpose — invariant 13 says anything the server
 * schedules has to be stoppable, and a limiter that keeps the event loop alive
 * would hang `test/boot.test.js` exactly the way the cron task once did. Expired
 * entries are dropped when their key is next seen, and a bounded sweep runs
 * inline every `SWEEP_EVERY` requests so an address that never returns cannot
 * accumulate.
 */

/** Requests between inline sweeps of expired entries. */
const SWEEP_EVERY = 1000;

/**
 * The client's address.
 *
 * `req.ip` is only trustworthy when Express is told to trust the proxy — see
 * `trustProxy` in config. Without it, every request behind a load balancer
 * carries the balancer's own address and the whole deployment shares one
 * bucket, which is why TRUST_PROXY belongs in any hosted environment.
 */
const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * @param {{ windowMs: number, max: number, enabled?: boolean }} options
 * @returns {import('express').RequestHandler}
 */
const createRateLimit = ({ windowMs, max, enabled = true }) => {
  // A non-positive limit means "no limiting" rather than "reject everything" —
  // the failure mode of a mistyped env var should not be a dead API.
  if (!enabled || !(max > 0) || !(windowMs > 0)) return (req, res, next) => next();

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let sinceSweep = 0;

  return (req, res, next) => {
    const now = Date.now();

    if ((sinceSweep += 1) >= SWEEP_EVERY) {
      sinceSweep = 0;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = clientKey(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      // Same shape as every other error this API returns, so a client that
      // already handles the boot-time 503 needs no new parsing to survive it.
      return res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds: retryAfter,
      });
    }

    return next();
  };
};

module.exports = { createRateLimit };
