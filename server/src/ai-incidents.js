'use strict';

const crypto = require('node:crypto');

const { lineToType } = require('./lines');

const INCIDENT_SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_GROUP_SIZE = 30;

/**
 * Phrases that announce the end of a disruption and can mean nothing else.
 *
 * `@AlertMPK`'s own house style ("ul. Reymonta - ruch przywrócony"), which is
 * why this was once the whole test.
 */
const RESTORED_WORDS = /\b(ruch\s+(?:przywr[oó]con[oy]|normalny)|wznowiono|przywr[oó]con[oy]|przywr[oó]cono|kursowanie\s+wznowione|kursuj[ąa]\s+normalnie)/i;

/**
 * Vehicles going back to what they normally do.
 *
 * "Autobusy wracają do obsługi przystanku", "…do realizacji stałych
 * przystanków", "tramwaje wracają na swoje stałe trasy przejazdu" — the
 * account says this at least as often as it says "przywrócony", and none of
 * it matched, so a finished closure was published as `active`. The target of
 * the return has to be named: a bare "wracają" could just as well put a line
 * back onto a diversion.
 */
const RETURNING_TO_NORMAL =
  /\bwraca(?:j[ąa])?\s+(?:na|do)\s+(?:swoj\w*\s+)?(?:sta[łl]\w*|obs[łl]ug\w*|realizacj\w*|tras\w*|przystank\w*|rozk[łl]ad\w*)/iu;

/**
 * The works or the fault being over — "Naprawa … zakończona", "Roboty drogowe
 * … zakończone", "awaria usunięta".
 *
 * Guarded on purpose. `zakończone` alone just as easily ends a *service*
 * ("kursowanie linii 100 zakończone"), which is a disruption rather than a
 * restoration, so the adjectival form only counts in a text that also names
 * the works or the fault. The noun `zakończenie` is excluded by the same
 * token — `zakończen-` never matches `zakończon-`.
 */
const ENDED_WORDS = /\b(zakończon[aeoy]|usuni[eę]t[aeoy])\b/iu;
const WORKS_WORDS = /\b(naprawa|naprawy|roboty|prace|remont\w*|awari\w*|usterk\w*|utrudnieni\w*|objazd\w*)/iu;

/**
 * Does this text say the disruption is over?
 *
 * Kept as a function rather than one larger alternation because the third
 * rule needs two matches in the same text, and because "a fake disruption is
 * worse than a missing one" cuts both ways here: an incident still flagged
 * `active` after the street reopened sends people around a closure that is
 * not there any more.
 *
 * @param {string} text
 * @returns {boolean}
 */
const isRestored = (text) =>
  RESTORED_WORDS.test(text) ||
  RETURNING_TO_NORMAL.test(text) ||
  (ENDED_WORDS.test(text) && WORKS_WORDS.test(text));
const UPDATE_WORDS = /\b(aktualizacja|aktualnie|update|zmiana|dalej|nadal)\b/i;
const REPLACEMENT_WORDS = /\b(komunikacj[\p{L}]*\s+zast[eę]pcz[\p{L}]*|zast[eę]pcz[\p{L}]*\s+komunikacj[\p{L}]*|autobus[\p{L}]*\s+zast[eę]pcz[\p{L}]*)/iu;
const DIVERSION_WORDS = /\b(objazd|objazdem|zmian[\p{L}]*\s+tras[\p{L}]*|skierowan[\p{L}]*\s+objazd)/iu;
const MAJOR_WORDS = /\b(brak\s+przejazdu|wstrzyman[\p{L}]*|komunikacj[\p{L}]*\s+zast[eę]pcz[\p{L}]*|zast[eę]pcz[\p{L}]*\s+komunikacj[\p{L}]*)/iu;
const DISRUPTION_WORDS = /\b(brak|awari[\p{L}]*|utrudnien[\p{L}]*|wstrzyman[\p{L}]*|objazd[\p{L}]*|zablokowan[\p{L}]*|kolizj[\p{L}]*|wypad[\p{L}]*)/iu;

const VALID_STATUS = new Set(['active', 'resolved', 'unknown']);
const VALID_SEVERITY = new Set(['minor', 'moderate', 'major', 'unknown']);
const VALID_KIND = new Set([
  'reported',
  'diversion',
  'replacement_bus',
  'update',
  'resolved',
  'unknown',
]);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

const LOCATION_STOP_WORDS = new Set([
  'alertmpk', 'aktualizacja', 'autobus', 'autobusy', 'autobusowa', 'autobusową',
  'awaria', 'brak', 'czasie', 'godzina', 'godziny', 'komunikacja', 'komunikację',
  'kolizja', 'kursowanie', 'linia', 'linie', 'linii', 'mpk', 'objazd', 'połamany',
  'przejazdu', 'przywrócony', 'przywrócono', 'ruch', 'tramwaj', 'tramwaje',
  'tramwajowa', 'utrudnienia', 'wrocław', 'wstrzymany', 'wypadek', 'wznowiono',
  'zastępcza', 'zastępczą', 'zadysponowano', 'zmiana', 'zmiany',
]);

const textForAlert = (alert) => `${alert?.title ?? ''} ${alert?.content ?? ''}`.trim();
const asTimestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const uniqueStrings = (values) => [...new Set(
  (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean),
)];
const clampText = (value, max, nullable = false) => {
  if (value == null && nullable) return null;
  if (typeof value !== 'string') throw new Error('expected text');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text && nullable) return null;
  if (!text) throw new Error('empty text');
  return text.slice(0, max);
};

const HEADLINE_MAX = 120;
const HEADLINE_MIN = 24;

/**
 * Polish abbreviations whose full stop is not the end of a sentence.
 *
 * "ul." and "godz." are in almost every AlertMPK post, and splitting on them
 * produces a two-word headline ("Awaria na ul.") with the whole notice as its
 * detail — which is the duplication this function exists to remove, wearing a
 * hat.
 */
const ABBREVIATION_END = /(?:^|\s)(?:ul|al|pl|os|godz|ok|tzw|im|st|nr|dot|tj|np|min|szt|wg|r)\.$/i;

/**
 * Split one notice into a headline and the rest of it.
 *
 * An X post has no title of its own: `title` is null and `content` is the whole
 * post. Using the post for both — a 120-character `title` and the full text as
 * `detail` — printed it twice in the timeline, and a third time as the
 * incident summary above. So the first sentence becomes the headline and what
 * follows becomes the detail: every word still reaches the reader, exactly
 * once. A notice with no usable sentence break is cut at a word boundary for
 * the same reason, rather than truncated with the full text repeated under it.
 *
 * @param {string} raw
 * @returns {{ title: string|null, detail: string|null }}
 */
const splitHeadline = (raw) => {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { title: null, detail: null };
  if (text.length <= HEADLINE_MAX) return { title: text, detail: null };

  const boundary = /[.!?…](?=\s)/g;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    const head = text.slice(0, match.index + 1);
    if (head.length > HEADLINE_MAX) break;
    if (head.length < HEADLINE_MIN || ABBREVIATION_END.test(head)) continue;
    const rest = text.slice(match.index + 1).trim();
    if (rest) return { title: head, detail: rest.slice(0, 500) };
    break;
  }

  // Cut at a word boundary — but not one that leaves a stray word or two
  // underneath the headline, which reads as a typesetting accident rather than
  // as detail. Backing the cut up gives the second line something to say.
  const space = text.lastIndexOf(' ', HEADLINE_MAX);
  const earlier = text.lastIndexOf(' ', text.length - HEADLINE_MIN);
  const boundaries = [space, earlier].filter((index) => index > HEADLINE_MIN && index <= HEADLINE_MAX);
  const cut = boundaries.length ? Math.min(...boundaries) : Math.min(space > 0 ? space : HEADLINE_MAX, HEADLINE_MAX);
  return { title: text.slice(0, cut).trim(), detail: text.slice(cut).trim().slice(0, 500) };
};

const warsawDate = (timestamp) => new Date(asTimestamp(timestamp)).toLocaleDateString('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const canonicalLocationToken = (token) => token
  .toLocaleLowerCase('pl-PL')
  // Common Polish locative/adjectival forms used in AlertMPK follow-ups.
  .replace(/iej$/u, 'a')
  .replace(/inie$/u, 'in');

/**
 * Conservative place-name vocabulary for pre-clustering.
 *
 * Alert prose contains many repeated operational words ("trasie", "kierunku",
 * "wracają") which are not locations. Treating every word as a place merged
 * unrelated disruptions. AlertMPK writes place names as proper names, so keep
 * only capitalised/all-caps words after stripping punctuation and known prose.
 */
const locationTokensForAlert = (alert) => {
  let text = textForAlert(alert);
  text = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')
    .replace(/\b\d+[a-z]?\b/gi, ' ')
    .replace(/[^\p{L}\s/-]/gu, ' ');

  return new Set(
    text
      .split(/[\s/-]+/)
      .map((token) => token.trim())
      .filter((token) => {
        const normalized = canonicalLocationToken(token);
        const looksNamed = /^\p{Lu}/u.test(token) || /^\p{Lu}+$/u.test(token);
        return normalized.length >= 3
          && looksNamed
          && !LOCATION_STOP_WORDS.has(normalized);
      })
      .map(canonicalLocationToken),
  );
};

const hasOverlap = (left, right) => {
  for (const value of left) if (right.has(value)) return true;
  return false;
};

const clusterAlerts = (alerts, { windowMs = DEFAULT_WINDOW_MS, maxGroupSize = DEFAULT_MAX_GROUP_SIZE } = {}) => {
  const ordered = [...(Array.isArray(alerts) ? alerts : [])]
    .filter((alert) => alert && alert.id != null && Number.isFinite(Number(alert.timestamp)))
    .sort((a, b) => asTimestamp(a.timestamp) - asTimestamp(b.timestamp));
  const groups = [];

  for (const alert of ordered) {
    const timestamp = asTimestamp(alert.timestamp);
    const lines = new Set(uniqueStrings(alert.affected).map((line) => line.toUpperCase()));
    const locations = locationTokensForAlert(alert);
    const isFollowUp = UPDATE_WORDS.test(textForAlert(alert)) || isRestored(textForAlert(alert));
    let best = null;
    let bestScore = -1;

    for (const group of groups) {
      // windowMs alone bounds relatedness; a same-calendar-day check on top of
      // it used to split an incident that crossed local midnight (e.g. reported
      // 23:58, resolved 00:05) into two, so the resolution never linked back to
      // its report.
      if (timestamp - group.lastTimestamp > windowMs) continue;
      if (group.alerts.length >= maxGroupSize) continue;
      const lineMatch = hasOverlap(lines, group.lines);
      const locationMatch = hasOverlap(locations, group.locations);
      const bothHaveLocations = locations.size > 0 && group.locations.size > 0;
      const related = bothHaveLocations
        ? locationMatch
        : lineMatch && isFollowUp;
      if (!related) continue;
      const score = (lineMatch ? 4 : 0) + (locationMatch ? 3 : 0) + (isFollowUp ? 1 : 0);
      if (score > bestScore || (score === bestScore && group.lastTimestamp > best?.lastTimestamp)) {
        best = group;
        bestScore = score;
      }
    }

    if (!best) {
      groups.push({
        alerts: [alert],
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        lines,
        locations,
      });
      continue;
    }

    best.alerts.push(alert);
    best.lastTimestamp = timestamp;
    for (const line of lines) best.lines.add(line);
    for (const location of locations) best.locations.add(location);
  }

  return groups.map((group) => group.alerts);
};

const incidentFingerprintForAlert = (alert) => {
  const parts = [
    warsawDate(alert?.timestamp),
    ...uniqueStrings(alert?.affected).map((line) => line.toUpperCase()).sort(),
    ...[...locationTokensForAlert(alert)].sort(),
    String(alert?.id ?? ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20);
};

const incidentIdForAlerts = (alerts) => {
  const ids = alerts.map((alert) => String(alert.id)).sort();
  return `incident-${crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 20)}`;
};

const classifyFallbackEvent = (alert) => {
  const text = textForAlert(alert);
  if (isRestored(text)) return 'resolved';
  if (REPLACEMENT_WORDS.test(text)) return 'replacement_bus';
  if (UPDATE_WORDS.test(text)) return 'update';
  if (DIVERSION_WORDS.test(text)) return 'diversion';
  if (text) return 'reported';
  return 'unknown';
};

const fallbackIncidentForGroup = (alerts, error = 'AI disabled') => {
  const ordered = [...alerts].sort((a, b) => asTimestamp(a.timestamp) - asTimestamp(b.timestamp));
  const sourceAlertIds = ordered.map((alert) => String(alert.id));
  const affected = uniqueStrings(ordered.flatMap((alert) => alert.affected ?? []))
    .map((line) => line.toUpperCase());
  const types = {};
  for (const line of affected) {
    const sourceType = ordered.map((alert) => alert.types?.[line]).find(Boolean);
    types[line] = sourceType ?? lineToType(line);
  }
  const combinedText = ordered.map(textForAlert).join(' ');
  const resolved = ordered.some((alert) => isRestored(textForAlert(alert)));
  const severity = MAJOR_WORDS.test(combinedText) || affected.length >= 4
    ? 'major'
    : affected.length >= 2 || DISRUPTION_WORDS.test(combinedText)
      ? 'moderate'
      : 'unknown';
  const newest = ordered.at(-1);
  const oldest = ordered[0];
  const titleSource = oldest?.title || oldest?.content || 'Utrudnienia w komunikacji';
  const summarySource = newest?.content || newest?.title || titleSource;
  const hints = [...new Set(ordered.flatMap((alert) => [...locationTokensForAlert(alert)]))];

  return {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    id: incidentIdForAlerts(ordered),
    status: resolved ? 'resolved' : (combinedText ? 'active' : 'unknown'),
    severity,
    // splitHeadline rather than a hard 120-character cut: the title sits above
    // the summary, and half a sentence followed by the whole of it reads as
    // the same text printed twice.
    title: splitHeadline(titleSource).title ?? 'Utrudnienia w komunikacji',
    locationName: hints.length ? hints.slice(0, 3).join(' / ') : null,
    affected,
    types,
    summary: clampText(summarySource, 240),
    shortNotificationTitle: null,
    shortNotificationBody: null,
    mapHints: { stopNames: [], streetNames: hints.slice(0, 8), areaNames: [] },
    timeline: ordered.map((alert) => {
      const kind = classifyFallbackEvent(alert);
      // A source with a real title of its own keeps it; a post that is nothing
      // but body text is split rather than printed as both title and detail.
      const parts = alert.title && alert.title !== alert.content
        ? { title: clampText(alert.title, 120), detail: clampText(alert.content, 500, true) }
        : splitHeadline(alert.content || alert.title || 'Aktualizacja');
      return {
        id: `event-${incidentFingerprintForAlert(alert)}`,
        timestamp: asTimestamp(alert.timestamp),
        kind,
        title: parts.title ?? 'Aktualizacja',
        detail: parts.detail,
        sourceAlertIds: [String(alert.id)],
      };
    }),
    sourceAlertIds,
    firstSeenAt: asTimestamp(oldest?.timestamp),
    lastUpdatedAt: asTimestamp(newest?.timestamp),
    ai: {
      generated: false,
      provider: null,
      model: null,
      confidence: null,
      error,
    },
  };
};

const createFallbackIncidentsWithOptions = (alerts, options = {}) =>
  clusterAlerts(alerts, options).map((group) => fallbackIncidentForGroup(group, options.error));

const createFallbackIncidents = (alerts) =>
  createFallbackIncidentsWithOptions(alerts, { error: 'AI disabled' });

const normalizeNames = (value) => {
  if (!Array.isArray(value)) throw new Error('invalid map hints');
  return uniqueStrings(value)
    .filter((name) => !/^-?\d{1,3}(?:[.,]\d+)?\s*[,;]\s*-?\d{1,3}(?:[.,]\d+)?$/.test(name))
    .map((name) => name.slice(0, 120))
    .slice(0, 20);
};

const normalizeIncidentPayloadOrThrow = (payload, alerts, metadata = {}) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.incidents)) {
    throw new Error('missing incidents array');
  }
  if (!payload.incidents.length) throw new Error('empty incidents array');

  const sourceById = new Map(alerts.map((alert) => [String(alert.id), alert]));
  const expectedIds = new Set(sourceById.keys());
  const usedIds = new Set();

  const incidents = payload.incidents.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('invalid incident');
    const sourceAlertIds = uniqueStrings(candidate.sourceAlertIds);
    if (!sourceAlertIds.length || sourceAlertIds.some((id) => !sourceById.has(id))) {
      throw new Error('invalid incident source ids');
    }
    for (const id of sourceAlertIds) {
      if (usedIds.has(id)) throw new Error('source alert used twice');
      usedIds.add(id);
    }
    if (!VALID_STATUS.has(candidate.status) || !VALID_SEVERITY.has(candidate.severity)) {
      throw new Error('invalid incident classification');
    }

    const incidentAlerts = sourceAlertIds.map((id) => sourceById.get(id));
    const allowedLines = new Set(
      incidentAlerts.flatMap((alert) => alert.affected ?? []).map((line) => String(line).toUpperCase()),
    );
    // AI may organize the prose, but the line union is deterministic source
    // data. This both drops invented lines and prevents a model omission from
    // hiding a genuinely affected line.
    const affected = [...allowedLines];
    const types = {};
    for (const line of affected) {
      types[line] = incidentAlerts.map((alert) => alert.types?.[line]).find(Boolean) ?? lineToType(line);
    }

    if (!Array.isArray(candidate.timeline) || !candidate.timeline.length) {
      throw new Error('invalid timeline');
    }
    const timeline = candidate.timeline.map((event) => {
      if (!event || typeof event !== 'object' || !VALID_KIND.has(event.kind)) {
        throw new Error('invalid timeline event');
      }
      const eventSourceIds = uniqueStrings(event.sourceAlertIds);
      if (!eventSourceIds.length || eventSourceIds.some((id) => !sourceAlertIds.includes(id))) {
        throw new Error('invalid timeline source ids');
      }
      const sourceTimestamps = eventSourceIds.map((id) => asTimestamp(sourceById.get(id).timestamp));
      return {
        id: typeof event.id === 'string' && event.id.trim()
          ? event.id.trim().slice(0, 160)
          : `event-${incidentFingerprintForAlert(sourceById.get(eventSourceIds[0]))}`,
        timestamp: Math.min(...sourceTimestamps),
        kind: event.kind,
        title: clampText(event.title, 120),
        detail: clampText(event.detail, 500, true),
        sourceAlertIds: eventSourceIds,
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
    const timelineSourceIds = new Set(timeline.flatMap((event) => event.sourceAlertIds));
    if (sourceAlertIds.some((id) => !timelineSourceIds.has(id))) {
      throw new Error('timeline omitted a source alert');
    }

    const timestamps = incidentAlerts.map((alert) => asTimestamp(alert.timestamp));
    const mapHints = candidate.mapHints;
    if (!mapHints || typeof mapHints !== 'object' || Array.isArray(mapHints)) {
      throw new Error('invalid map hints');
    }
    const confidence = candidate.ai?.confidence ?? candidate.confidence ?? null;
    if (confidence !== null && !VALID_CONFIDENCE.has(confidence)) {
      throw new Error('invalid confidence');
    }

    return {
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      id: incidentIdForAlerts(incidentAlerts),
      // The model's own status only stands where this says nothing: a text
      // that announces the end of the disruption overrides an `active` the
      // model returned anyway, which is exactly what it kept doing.
      status: incidentAlerts.some((alert) => isRestored(textForAlert(alert)))
        ? 'resolved'
        : candidate.status,
      severity: candidate.severity,
      title: clampText(candidate.title, 120),
      locationName: clampText(candidate.locationName, 120, true),
      affected,
      types,
      summary: clampText(candidate.summary, 240),
      shortNotificationTitle: clampText(candidate.shortNotificationTitle, 60, true),
      shortNotificationBody: clampText(candidate.shortNotificationBody, 120, true),
      mapHints: {
        stopNames: normalizeNames(mapHints.stopNames),
        streetNames: normalizeNames(mapHints.streetNames),
        areaNames: normalizeNames(mapHints.areaNames),
      },
      timeline,
      sourceAlertIds,
      firstSeenAt: Math.min(...timestamps),
      lastUpdatedAt: Math.max(...timestamps),
      ai: {
        generated: true,
        provider: metadata.provider ?? null,
        model: metadata.model ?? null,
        confidence,
        error: null,
      },
    };
  });

  if (usedIds.size !== expectedIds.size || [...expectedIds].some((id) => !usedIds.has(id))) {
    throw new Error('not all source alerts were preserved');
  }
  return incidents.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
};

const normalizeIncidentPayload = (payload, alerts, metadata = {}) => {
  try {
    return normalizeIncidentPayloadOrThrow(payload, alerts, metadata);
  } catch {
    return createFallbackIncidentsWithOptions(alerts, {
      error: 'Invalid AI incident payload',
      maxGroupSize: alerts.length || DEFAULT_MAX_GROUP_SIZE,
    });
  }
};

const SYSTEM_PROMPT = `You build public-transport incident timelines from AlertMPK posts.
Understand Polish place names and operational wording, but return only strict JSON.
Rules:
- Use only the supplied alerts. Do not invent facts, lines, coordinates, or source IDs.
- Preserve every sourceAlertId exactly. Merge related posts into one incident.
- A shared line or generic operational wording is not enough to merge different locations.
- Split posts into separate incidents when their named streets, stops, or termini conflict.
- If a post says "ruch przywrócony", "wznowiono", or "przywrócony", status is resolved.
- Timeline timestamps must come from the supplied source alerts.
- summary must be Polish and at most 240 characters.
- shortNotificationTitle is Polish, null or at most 60 characters.
- shortNotificationBody is Polish, null or at most 120 characters.
- mapHints contain names only, never latitude/longitude or coordinates.
- affected may contain only lines present in the supplied affected arrays.
Return exactly {"incidents":[incident,...]}. Each incident has:
schemaVersion, id, status (active|resolved|unknown), severity (minor|moderate|major|unknown),
title, locationName (string|null), affected, types, summary, shortNotificationTitle,
shortNotificationBody, mapHints {stopNames,streetNames,areaNames}, timeline, sourceAlertIds,
firstSeenAt, lastUpdatedAt, and ai {confidence (low|medium|high|null)}.
Each timeline item has id, timestamp, kind
(reported|diversion|replacement_bus|update|resolved|unknown), title, detail, sourceAlertIds.`;

/**
 * Identifies a cluster by exactly what would be sent to the provider for it.
 * Keying the AI cache on the whole alert batch meant one unrelated new post
 * anywhere in the city invalidated every settled incident's narrative, so a
 * quiet incident's wording could still change on every 5-minute refresh and
 * cost a provider call it didn't need. Keying per group instead means only
 * clusters that actually changed get re-sent.
 */
const groupCacheKey = (group) => {
  const sorted = [...group].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
};

const buildIncidentsFromAlerts = async (alerts, options = {}) => {
  const safeAlerts = Array.isArray(alerts) ? alerts : [];
  if (!safeAlerts.length) return [];
  const provider = options.provider;
  const maxInputAlerts = Number.isFinite(options.maxInputAlerts) && options.maxInputAlerts > 0
    ? Math.floor(options.maxInputAlerts)
    : DEFAULT_MAX_GROUP_SIZE;
  const groups = clusterAlerts(safeAlerts, {
    windowMs: options.windowMs,
    maxGroupSize: maxInputAlerts,
  }).sort((left, right) =>
    asTimestamp(right.at(-1)?.timestamp) - asTimestamp(left.at(-1)?.timestamp));
  const providerError = provider?.status?.reason || 'AI disabled';

  if (!provider?.enabled || typeof provider.completeJson !== 'function') {
    return groups
      .map((group) => fallbackIncidentForGroup(group, providerError))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  const cache = options.cache instanceof Map ? options.cache : null;
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : 0;
  const liveCacheKeys = new Set();

  let inputAlertsUsed = 0;
  const results = await Promise.all(groups.map(async (group) => {
    const cacheKey = cache ? groupCacheKey(group) : null;
    if (cacheKey) liveCacheKeys.add(cacheKey);
    if (cacheKey && cacheTtlMs > 0) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.incidents;
    }

    // The provider sees at most maxInputAlerts source records per refresh,
    // regardless of how many candidate groups the raw feed contains.
    if (inputAlertsUsed + group.length > maxInputAlerts) {
      return [fallbackIncidentForGroup(group, 'AI input alert limit reached')];
    }
    inputAlertsUsed += group.length;
    try {
      const payload = await provider.completeJson({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({ alerts: group }),
        schemaName: 'alertmpk_incidents_v1',
      });
      const incidents = normalizeIncidentPayload(payload, group, {
        provider: provider.name ?? null,
        model: options.model ?? null,
      });
      if (cacheKey && cacheTtlMs > 0 && incidents.every((incident) => incident.ai.generated)) {
        cache.set(cacheKey, { incidents, expiresAt: Date.now() + cacheTtlMs });
      }
      return incidents;
    } catch (error) {
      return [fallbackIncidentForGroup(group, error?.message || 'AI incident generation failed')];
    }
  }));

  if (cache) {
    // Drop entries for clusters that no longer exist (resolved and aged out of
    // the feed, or merged into a different cluster) so the cache does not grow
    // without bound across the process lifetime.
    for (const key of cache.keys()) {
      if (!liveCacheKeys.has(key)) cache.delete(key);
    }
  }

  return results.flat().sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
};

module.exports = {
  INCIDENT_SCHEMA_VERSION,
  buildIncidentsFromAlerts,
  classifyFallbackEvent,
  createFallbackIncidents,
  incidentFingerprintForAlert,
  normalizeIncidentPayload,
  splitHeadline,
};
