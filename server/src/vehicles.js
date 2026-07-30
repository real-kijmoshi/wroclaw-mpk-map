'use strict';

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout, tryEachSource } = require('./http');
const { lineToType } = require('./lines');
const { distanceMeters } = require('./gtfs/geo');

// Anything outside this box is a bad fix, not a vehicle in Wrocław.
const BOUNDS = { minLat: 50.8, maxLat: 51.4, minLon: 16.6, maxLon: 17.5 };

const inBounds = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= BOUNDS.minLat &&
  lat <= BOUNDS.maxLat &&
  lon >= BOUNDS.minLon &&
  lon <= BOUNDS.maxLon;

const FIELD_ALIASES = {
  lat: ['x', 'lat', 'latitude', 'szerokosc', 'y_wgs84'],
  lon: ['y', 'lon', 'lng', 'longitude', 'dlugosc', 'x_wgs84'],
  line: ['name', 'line', 'linia', 'route', 'route_short_name', 'nazwa_linii'],
  id: ['k', 'id', 'vehicle_id', 'nr_boczny', 'brigade'],
};

const pick = (row, aliases) => {
  for (const key of aliases) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
};

/**
 * Normalise one upstream record.
 *
 * MPK's `bus_position` returns `{ x, y, name, k, type }` where `x` is latitude.
 * Field names have changed before, so aliases are accepted rather than assuming
 * one exact shape.
 */
const normalizeVehicle = (row) => {
  if (!row || typeof row !== 'object') return null;

  const lat = Number.parseFloat(pick(row, FIELD_ALIASES.lat));
  const lon = Number.parseFloat(pick(row, FIELD_ALIASES.lon));
  if (!inBounds(lat, lon)) return null;

  const line = String(pick(row, FIELD_ALIASES.line) ?? '').trim();
  if (!line) return null;

  const rawId = pick(row, FIELD_ALIASES.id);
  return {
    id: rawId !== undefined ? `${line}-${rawId}` : `${line}-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    line,
    type: lineToType(line),
    lat,
    lon,
  };
};

/** Compass bearing in degrees from one position to the next. */
const bearing = (fromLat, fromLon, toLat, toLon) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLon = toRad(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRad(toLat));
  const x =
    Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) -
    Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

/**
 * Polls the live vehicle-position endpoint and keeps the last known fleet
 * state, enriched with heading and how long each vehicle has been standing
 * still. Never throws at the caller: a failed poll keeps the previous snapshot
 * and is reported through `status`.
 */
class VehicleTracker {
  constructor(getLines) {
    this.getLines = getLines;
    /** @type {Map<string, object>} vehicle id -> last known state */
    this.fleet = new Map();
    this.timer = null;
    this.status = {
      source: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailures: 0,
      count: 0,
    };
  }

  get snapshot() {
    const cutoff = Date.now() - config.vehicles.staleAfterMs;
    const vehicles = [];
    for (const vehicle of this.fleet.values()) {
      if (vehicle.updatedAt < cutoff) continue;
      vehicles.push({
        id: vehicle.id,
        line: vehicle.line,
        type: vehicle.type,
        lat: vehicle.lat,
        lon: vehicle.lon,
        heading: vehicle.heading,
        updatedAt: new Date(vehicle.updatedAt).toISOString(),
      });
    }
    return {
      locations: vehicles,
      count: vehicles.length,
      lastUpdated: this.status.lastSuccessAt,
      source: this.status.source,
      stale: this.status.consecutiveFailures > 0,
    };
  }

  async #request(url, lines) {
    const body = new URLSearchParams();
    for (const line of lines.allBuses) body.append('busList[bus][]', line);
    for (const line of lines.allTrams) body.append('busList[tram][]', line);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      timeoutMs: config.vehicles.timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON, got ${text.slice(0, 60).replace(/\s+/g, ' ')}…`);
    }

    // Accept both a bare array and a wrapper object, since the endpoint has
    // returned both shapes over its lifetime.
    const rows = Array.isArray(payload)
      ? payload
      : payload.vehicles ?? payload.data ?? payload.locations ?? null;
    if (!Array.isArray(rows)) throw new Error('response did not contain a list of vehicles');
    if (!rows.length) throw new Error('response contained no vehicles');

    return rows;
  }

  /** Fetch once and merge into the fleet. Resolves even when the poll fails. */
  async poll() {
    const lines = this.getLines();
    if (!lines || (!lines.allBuses.length && !lines.allTrams.length)) return this.status;

    this.status.lastAttemptAt = new Date().toISOString();

    try {
      const { url, value: rows } = await tryEachSource(
        config.vehicles.sources,
        (candidate) => this.#request(candidate, lines),
        { label: 'vehicle position' },
      );

      const now = Date.now();
      let accepted = 0;

      for (const row of rows) {
        const vehicle = normalizeVehicle(row);
        if (!vehicle) continue;
        accepted += 1;

        const previous = this.fleet.get(vehicle.id);
        let heading = previous?.heading ?? null;
        if (previous && distanceMeters(previous.lat, previous.lon, vehicle.lat, vehicle.lon) > 15) {
          heading = Math.round(bearing(previous.lat, previous.lon, vehicle.lat, vehicle.lon));
        }

        this.fleet.set(vehicle.id, { ...vehicle, heading, updatedAt: now });
      }

      // Drop vehicles that stopped reporting a while ago.
      const cutoff = now - config.vehicles.staleAfterMs * 2;
      for (const [id, vehicle] of this.fleet) {
        if (vehicle.updatedAt < cutoff) this.fleet.delete(id);
      }

      this.status = {
        ...this.status,
        source: url,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        count: accepted,
      };

      if (accepted === 0) logger.warn('Vehicle poll returned rows but none were usable');
    } catch (error) {
      this.status.consecutiveFailures += 1;
      this.status.lastError = error.message;
      // Only shout about it once it is clearly not a blip.
      const log = this.status.consecutiveFailures === 1 ? logger.debug : logger.warn;
      log(`Vehicle poll failed (${this.status.consecutiveFailures}x): ${error.message}`);
    }

    return this.status;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), config.vehicles.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { VehicleTracker, normalizeVehicle, bearing, BOUNDS };
