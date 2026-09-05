'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  INCIDENT_SCHEMA_VERSION,
  buildIncidentsFromAlerts,
  classifyFallbackEvent,
  createFallbackIncidents,
  incidentFingerprintForAlert,
  normalizeIncidentPayload,
  splitHeadline,
} = require('../src/ai-incidents');
const { AlertsService } = require('../src/alerts');

const at = (time) => Date.parse(`2026-08-10T${time}:00+02:00`);
const alerts = [
  {
    id: 'alert-1',
    title: null,
    content: 'Brak przejazdu - ul. Reymonta/Kleczkowska. Autobusy linii K, 142 wstrzymane.',
    url: 'https://x.com/AlertMPK/status/1',
    timestamp: at('09:42'),
    source: 'x-bridge:test',
    affected: ['K', '142'],
    types: { K: 'express', 142: 'bus' },
  },
  {
    id: 'alert-2',
    title: null,
    content: 'Zadysponowano zastępczą komunikację autobusową w rejon ul. Reymonta/Kleczkowskiej.',
    url: 'https://x.com/AlertMPK/status/2',
    timestamp: at('09:55'),
    source: 'x-bridge:test',
    affected: [],
    types: {},
  },
  {
    id: 'alert-3',
    title: null,
    content: 'AKTUALIZACJA 10:06 Autobusy linii K, 142 i 144 kursują objazdem.',
    url: 'https://x.com/AlertMPK/status/3',
    timestamp: at('10:06'),
    source: 'x-bridge:test',
    affected: ['K', '142', '144'],
    types: { K: 'express', 142: 'bus', 144: 'bus' },
  },
  {
    id: 'alert-4',
    title: null,
    content: 'ul. Reymonta/Kleczkowska - ruch przywrócony. Linie K, 142 i 144 wracają na trasy.',
    url: 'https://x.com/AlertMPK/status/4',
    timestamp: at('10:24'),
    source: 'x-bridge:test',
    affected: ['K', '142', '144'],
    types: { K: 'express', 142: 'bus', 144: 'bus' },
  },
];

const modelPayload = (sourceAlerts) => ({
  incidents: [{
    status: 'resolved',
    severity: 'major',
    title: 'Utrudnienia przy Reymonta i Kleczkowskiej',
    locationName: 'Reymonta / Kleczkowska',
    summary: 'Ruch został przywrócony.',
    shortNotificationTitle: null,
    shortNotificationBody: null,
    mapHints: { stopNames: [], streetNames: ['Reymonta', 'Kleczkowska'], areaNames: [] },
    timeline: sourceAlerts.map((alert) => ({
      kind: classifyFallbackEvent(alert),
      title: alert.content,
      detail: null,
      sourceAlertIds: [alert.id],
    })),
    sourceAlertIds: sourceAlerts.map((alert) => alert.id),
    ai: { confidence: 'high' },
  }],
});

describe('recognising that a disruption is over', () => {
  // Both of these were served to the app as "Aktywne" while their own text
  // said the works had finished — a card telling people to avoid a street
  // that had already reopened. RESTORED_WORDS only knew @AlertMPK's
  // "ruch przywrócony" house style, and neither of these uses it.
  const post = (content) => ({
    id: `post-${content.slice(0, 12)}`,
    title: null,
    content,
    url: 'https://x.com/AlertMPK/status/1',
    timestamp: at('09:42'),
    source: 'x-bridge:test',
    affected: [],
    types: {},
  });

  const statusOf = (content) => createFallbackIncidents([post(content)])[0].status;

  const BARDZKA =
    'Naprawa płyt w buspasie na ul. Bardzkiej zakończona. Autobusy wracają do realizacji stałych przystanków w tym rejonie.';
  const MUCHOBORSKA =
    'Roboty drogowe na ul. Muchoborskiej zakończone. Autobusy wracają do obsługi przystanku "Muchobór Mały (Stacja Kolejowa)".';

  it('resolves the two posts that shipped as active', () => {
    assert.equal(statusOf(BARDZKA), 'resolved');
    assert.equal(statusOf(MUCHOBORSKA), 'resolved');
  });

  it('classifies them as resolution events, not fresh reports', () => {
    assert.equal(classifyFallbackEvent(post(BARDZKA)), 'resolved');
    assert.equal(classifyFallbackEvent(post(MUCHOBORSKA)), 'resolved');
  });

  it('reads "wracają na swoje stałe trasy" as restored', () => {
    assert.equal(
      statusOf('#AlertMPK ul. Buforowa - Autobusy wracają na swoje stałe trasy przejazdu.'),
      'resolved',
    );
  });

  it('still reads the house style it always did', () => {
    assert.equal(statusOf('#AlertMPK ul. Reymonta - ruch przywrócony.'), 'resolved');
    assert.equal(statusOf('Kursowanie wznowione na ul. Legnickiej po awarii.'), 'resolved');
  });

  it('treats a removed fault as restored', () => {
    assert.equal(statusOf('Awaria tramwaju na Świdnickiej usunięta.'), 'resolved');
  });

  it('does not read the end of a service as the end of a disruption', () => {
    // "zakończone" on its own ends a *service*, which is a disruption, not a
    // restoration. It only counts alongside the works or the fault.
    assert.notEqual(statusOf('Kursowanie linii 100 zostało zakończone.'), 'resolved');
    assert.notEqual(statusOf('Zakończenie kursowania linii nocnych.'), 'resolved');
  });

  it('does not resolve a disruption that is still running', () => {
    assert.notEqual(
      statusOf('Brak przejazdu - ul. Reymonta. Autobusy linii K, 142 wstrzymane.'),
      'resolved',
    );
    assert.notEqual(
      statusOf('Roboty drogowe na ul. Muchoborskiej. Autobusy jadą objazdem.'),
      'resolved',
    );
  });

  it('lets a resolution post override an active status from the model', async () => {
    // The model returned `active` for exactly these; the regex is the only
    // thing that overrides it, so it has to fire with AI on as well as off.
    const incidents = await buildIncidentsFromAlerts([post(BARDZKA)], {
      provider: {
        enabled: true,
        name: 'stub',
        async completeJson() {
          const source = post(BARDZKA);
          return {
            incidents: [
              {
                status: 'active',
                severity: 'moderate',
                title: 'Naprawa buspasa',
                locationName: 'Bardzka',
                summary: 'Naprawa płyt w buspasie.',
                shortNotificationTitle: null,
                shortNotificationBody: null,
                mapHints: { stopNames: [], streetNames: ['Bardzka'], areaNames: [] },
                timeline: [
                  { kind: 'reported', title: source.content, detail: null, sourceAlertIds: [source.id] },
                ],
                sourceAlertIds: [source.id],
                ai: { confidence: 'high' },
              },
            ],
          };
        },
      },
      model: 'stub-model',
    });

    assert.equal(incidents.length, 1);
    // Without this the test passes for the wrong reason: a stub with the wrong
    // method name falls through to the deterministic path, which returns
    // `resolved` on its own and proves nothing about the override.
    assert.equal(incidents[0].ai.generated, true, 'the AI path actually ran');
    assert.equal(incidents[0].status, 'resolved', 'the text wins over the model');
  });
});

describe('AI incident fallback', () => {
  it('pre-clusters related AlertMPK posts into one resolved, ascending timeline', async () => {
    const incidents = await buildIncidentsFromAlerts(alerts, {
      provider: {
        enabled: false,
        name: 'off',
        status: { reason: 'disabled in test' },
      },
    });

    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].schemaVersion, INCIDENT_SCHEMA_VERSION);
    assert.equal(incidents[0].status, 'resolved');
    assert.equal(incidents[0].severity, 'major');
    assert.deepEqual(incidents[0].affected.sort(), ['142', '144', 'K']);
    assert.deepEqual(
      incidents[0].timeline.map((event) => event.timestamp),
      alerts.map((alert) => alert.timestamp),
    );
    assert.deepEqual(
      incidents[0].timeline.map((event) => event.kind),
      ['reported', 'replacement_bus', 'update', 'resolved'],
    );
    assert.equal(incidents[0].ai.generated, false);
    assert.equal(incidents[0].ai.error, 'disabled in test');
  });

  it('exposes deterministic fallback helpers', () => {
    const first = createFallbackIncidents(alerts);
    const second = createFallbackIncidents([...alerts].reverse());
    assert.equal(first.length, 1);
    assert.equal(first[0].id, second[0].id);
    assert.equal(incidentFingerprintForAlert(alerts[0]), incidentFingerprintForAlert(alerts[0]));
    assert.equal(classifyFallbackEvent(alerts[1]), 'replacement_bus');
    assert.equal(classifyFallbackEvent(alerts[3]), 'resolved');
  });

  it('does not merge disruptions at different places merely because a line overlaps', () => {
    const separate = createFallbackIncidents([
      {
        id: 'grabiszynska',
        content: 'Brak przejazdu - ul. Grabiszyńska. Tramwaje linii 4 i 11 wstrzymane.',
        timestamp: at('08:00'),
        affected: ['4', '11'],
        types: { 4: 'tram', 11: 'tram' },
      },
      {
        id: 'biskupin',
        content: 'Kolizja na Biskupinie. Tramwaje linii 4 i 10 jadą objazdem.',
        timestamp: at('08:20'),
        affected: ['4', '10'],
        types: { 4: 'tram', 10: 'tram' },
      },
      {
        id: 'grabiszynska-restored',
        content: 'Grabiszyńska - ruch normalny. Tramwaje linii 4 i 11 wracają na trasy.',
        timestamp: at('08:40'),
        affected: ['4', '11'],
        types: { 4: 'tram', 11: 'tram' },
      },
      {
        id: 'biskupin-restored',
        content: 'Biskupin - ruch normalny. Linie 4 i 10 kursują normalnie.',
        timestamp: at('08:50'),
        affected: ['4', '10'],
        types: { 4: 'tram', 10: 'tram' },
      },
    ]);

    assert.equal(separate.length, 2);
    assert.deepEqual(
      separate.map((incident) => incident.sourceAlertIds),
      [
        ['grabiszynska', 'grabiszynska-restored'],
        ['biskupin', 'biskupin-restored'],
      ],
    );
    assert.ok(separate.every((incident) => incident.status === 'resolved'));
  });

  it('does not treat generic route wording as a shared location', () => {
    const separate = createFallbackIncidents([
      {
        id: 'fat-bus',
        content: 'Autobus zastępczy na trasie FAT - Pl. Legionów.',
        timestamp: at('11:00'),
        affected: [],
        types: {},
      },
      {
        id: 'bartoszowice-bus',
        content: 'Autobus zastępczy na trasie Wystawowa - Bartoszowice.',
        timestamp: at('11:10'),
        affected: [],
        types: {},
      },
    ]);

    assert.equal(separate.length, 2);
    assert.deepEqual(separate.map((incident) => incident.sourceAlertIds), [
      ['fat-bus'],
      ['bartoszowice-bus'],
    ]);
    assert.ok(separate.every((incident) => !incident.locationName.includes('trasie')));
  });
});

describe('AI incident validation', () => {
  it('uses source timestamps, drops invented lines, clamps copy and sorts the timeline', async () => {
    const provider = {
      enabled: true,
      name: 'test-ai',
      status: { reason: null },
      async completeJson() {
        return {
          incidents: [{
            schemaVersion: 99,
            id: 'invented-id',
            status: 'resolved',
            severity: 'major',
            title: 'Awaria przy Reymonta'.repeat(20),
            locationName: 'Reymonta / Kleczkowska',
            affected: ['K', '142', '144', '999'],
            types: { 999: 'tram' },
            summary: 'Przejazd został przywrócony.'.repeat(20),
            shortNotificationTitle: 'Ruch przywrócony przy Reymonta'.repeat(4),
            shortNotificationBody: 'Linie wracają na swoje trasy.'.repeat(10),
            mapHints: {
              stopNames: ['Kleczkowska'],
              streetNames: ['Reymonta'],
              areaNames: [],
            },
            timeline: [...alerts].reverse().map((alert, index) => ({
              id: `ai-event-${index}`,
              timestamp: 123,
              kind: index === 0 ? 'resolved' : 'update',
              title: 'Aktualizacja',
              detail: null,
              sourceAlertIds: [alert.id],
            })),
            sourceAlertIds: alerts.map((alert) => alert.id),
            ai: { confidence: 'high' },
          }],
        };
      },
    };

    const [incident] = await buildIncidentsFromAlerts(alerts, {
      provider,
      model: 'test-model',
    });
    assert.equal(incident.ai.generated, true);
    assert.equal(incident.ai.provider, 'test-ai');
    assert.equal(incident.ai.model, 'test-model');
    assert.deepEqual(incident.affected.sort(), ['142', '144', 'K']);
    assert.equal(incident.title.length, 120);
    assert.equal(incident.summary.length, 240);
    assert.equal(incident.shortNotificationTitle.length, 60);
    assert.equal(incident.shortNotificationBody.length, 120);
    assert.deepEqual(
      incident.timeline.map((event) => event.timestamp),
      alerts.map((alert) => alert.timestamp),
    );
  });

  it('rejects invalid LLM output and falls back for that candidate group', async () => {
    const provider = {
      enabled: true,
      name: 'broken-ai',
      status: { reason: null },
      async completeJson() {
        return {
          incidents: [{
            status: 'resolved',
            severity: 'major',
            title: 'Zmyślony incydent',
            summary: 'Brakuje prawdziwych identyfikatorów źródeł.',
            affected: ['999'],
            mapHints: { stopNames: [], streetNames: [], areaNames: [] },
            timeline: [],
            sourceAlertIds: ['not-a-source-alert'],
          }],
        };
      },
    };

    const [incident] = await buildIncidentsFromAlerts(alerts, { provider });
    assert.equal(incident.ai.generated, false);
    assert.match(incident.ai.error, /invalid ai incident payload/i);
    assert.equal(incident.status, 'resolved');
    assert.deepEqual(incident.sourceAlertIds, alerts.map((alert) => alert.id));
  });

  it('normalization itself is fail-soft', () => {
    const incidents = normalizeIncidentPayload(null, alerts);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].ai.generated, false);
  });
});

describe('AlertsService incident integration', () => {
  it('keeps raw alerts intact while publishing filterable fallback incidents', async () => {
    const rawItems = alerts.map(({ affected: _affected, types: _types, ...alert }) => alert);
    const service = new AlertsService(
      () => new Set(['K', '142', '144']),
      [{ name: 'fixture', async fetch() { return rawItems; } }],
      {
        aiProvider: {
          enabled: false,
          name: 'off',
          status: { reason: 'disabled in integration test' },
        },
      },
    );

    const raw = await service.refresh();
    assert.equal(raw, service.alerts);
    assert.equal(raw.length, 4);
    assert.equal(service.getAlerts().length, 4);
    assert.equal(service.getIncidents({ line: '144', status: 'resolved' }).length, 1);
    assert.equal(service.getIncidents({ status: 'active' }).length, 0);
    assert.equal(service.status.aiIncidents, service.incidentStatus);
    assert.equal(service.incidentStatus.lastError, 'disabled in integration test');
    assert.equal(service.incidentStatus.incidentCount, 1);
  });

  it('never calls a provider while AI is disabled', async () => {
    let calls = 0;
    const service = new AlertsService(
      () => new Set(['K', '142', '144']),
      [{ name: 'fixture', async fetch() { return alerts; } }],
      {
        aiProvider: {
          enabled: false,
          name: 'off',
          status: { reason: 'disabled in test' },
          async completeJson() { calls += 1; },
        },
      },
    );

    await service.refresh();
    assert.equal(calls, 0);
    assert.equal(service.getAlerts().length, 4);
    assert.equal(service.getIncidents().length, 1);
  });

  it('keeps /alerts state and publishes fallback incidents when the provider fails', async () => {
    const service = new AlertsService(
      () => new Set(['K', '142', '144']),
      [{ name: 'fixture', async fetch() { return alerts; } }],
      {
        aiProvider: {
          enabled: true,
          name: 'test-ai',
          status: { reason: null },
          async completeJson() { throw new Error('provider unavailable'); },
        },
        aiModel: 'test-model',
      },
    );

    const raw = await service.refresh();
    assert.equal(raw.length, 4);
    assert.equal(service.getAlerts().length, 4);
    assert.equal(service.getIncidents().length, 1);
    assert.equal(service.getIncidents()[0].ai.generated, false);
    assert.equal(service.incidentStatus.lastError, 'provider unavailable');
  });

  it('reuses successful AI incidents for unchanged alerts within the cache TTL', async () => {
    let calls = 0;
    const service = new AlertsService(
      () => new Set(['K', '142', '144']),
      [{ name: 'fixture', async fetch() { return alerts; } }],
      {
        aiProvider: {
          enabled: true,
          name: 'test-ai',
          status: { reason: null },
          async completeJson({ user }) {
            calls += 1;
            return modelPayload(JSON.parse(user).alerts);
          },
        },
        aiModel: 'test-model',
        aiCacheTtlMs: 60_000,
      },
    );

    await service.refresh();
    const generated = service.getIncidents();
    await service.refresh();

    assert.equal(calls, 1);
    assert.deepEqual(service.getIncidents(), generated);
    assert.equal(service.incidentStatus.lastError, null);
  });
});

describe('one notice, printed once', () => {
  // Observed in the app: an incident detail screen showed the same AlertMPK
  // post three times over — as the summary, as the timeline entry's title, and
  // again as that entry's detail. An X post has no title of its own, so the
  // fallback used its whole text for both fields and the client, comparing
  // them for equality, saw a 120-character truncation and a full text and
  // rendered both.
  const post = {
    id: 'post-1',
    title: null,
    content:
      '⚠️ Brak przejazdu - Podwale (awaria tramwaju). 🚋 Tramwaje linii 20>Leśnica ' +
      'zostały skierowane objazdem z pominięciem przystanku "Renoma".',
    url: 'https://x.com/AlertMPK/status/9',
    timestamp: at('15:54'),
    source: 'x-bridge:test',
    affected: ['20'],
    types: { 20: 'tram' },
  };

  it('does not repeat the post as both title and detail', () => {
    const [incident] = createFallbackIncidents([post]);
    const [event] = incident.timeline;

    assert.ok(event.detail, 'the rest of the post is still served');
    assert.notEqual(event.title, event.detail);
    assert.ok(
      !event.detail.includes(event.title),
      'the detail must not restate the headline above it',
    );
    assert.equal(`${event.title} ${event.detail}`, post.content, 'and nothing is lost');
  });

  it('keeps the incident title clear of the summary it sits above', () => {
    const [incident] = createFallbackIncidents([post]);

    assert.equal(incident.title, '⚠️ Brak przejazdu - Podwale (awaria tramwaju).');
    assert.ok(incident.summary.length > incident.title.length);
  });

  it('still carries a separate title through when the source has one', () => {
    // Notice pages do have real headlines, and those are not a duplicate of
    // the body — that path must not be collateral damage.
    const [incident] = createFallbackIncidents([{
      ...post,
      id: 'notice-1',
      title: 'Zmiana trasy linii 20',
      content: 'Od poniedziałku tramwaje linii 20 pojadą objazdem przez Podwale.',
    }]);

    assert.equal(incident.timeline[0].title, 'Zmiana trasy linii 20');
    assert.equal(
      incident.timeline[0].detail,
      'Od poniedziałku tramwaje linii 20 pojadą objazdem przez Podwale.',
    );
  });

  it('does not split on a Polish abbreviation', () => {
    // "ul." and "godz." end a token, not a sentence; splitting there leaves a
    // stub headline with the whole notice underneath it — the same bug again.
    const { title } = splitHeadline(
      'Zderzenie na ul. Legnickiej blokuje torowisko w obu kierunkach, tramwaje ' +
        'linii 3 i 10 kursują objazdem przez Poświętne aż do odwołania.',
    );

    assert.ok(title.length > 24, `headline too short: ${title}`);
    assert.ok(!/\bul\.$/.test(title));
  });

  it('leaves a short notice whole', () => {
    assert.deepEqual(splitHeadline('Awaria usunięta, ruch przywrócony.'), {
      title: 'Awaria usunięta, ruch przywrócony.',
      detail: null,
    });
  });
});

describe('re-parsing incidents on demand', () => {
  // A provider that was down leaves deterministic incidents behind, and
  // nothing invalidates them: a cluster that generated nothing cached nothing
  // to expire, so those incidents stay prose-free until a *new* post arrives.
  // This is that retry, on demand.
  const buildService = (provider) => new AlertsService(
    () => new Set(['K', '142', '144']),
    [{ name: 'fixture', async fetch() { return alerts; } }],
    { aiProvider: provider, aiCacheTtlMs: 60_000 },
  );

  const payloadFor = (group) => ({
    incidents: [{
      status: 'active',
      severity: 'moderate',
      title: 'Utrudnienia na Reymonta',
      locationName: 'Reymonta',
      summary: 'Autobusy kursują objazdem.',
      shortNotificationTitle: null,
      shortNotificationBody: null,
      mapHints: { stopNames: [], streetNames: ['Reymonta'], areaNames: [] },
      sourceAlertIds: group.alerts.map((alert) => String(alert.id)),
      timeline: group.alerts.map((alert) => ({
        kind: 'update',
        title: 'Aktualizacja',
        detail: null,
        sourceAlertIds: [String(alert.id)],
      })),
      ai: { confidence: 'medium' },
    }],
  });

  it('turns a failed run into a generated one without a new alert arriving', async () => {
    let down = true;
    let calls = 0;
    const service = buildService({
      enabled: true,
      name: 'openrouter',
      activeModel: 'test/model',
      models: ['test/model'],
      status: { reason: null },
      async completeJson({ user }) {
        calls += 1;
        if (down) throw new Error('AI provider timed out after 90000ms');
        return payloadFor(JSON.parse(user));
      },
    });

    await service.refresh();
    assert.equal(service.getIncidents().every((incident) => !incident.ai.generated), true);
    assert.match(service.incidentStatus.lastError, /timed out/);

    down = false;
    const result = await service.regenerateIncidents();

    assert.ok(result.generated > 0, 'the AI narrative is there on the second try');
    assert.equal(result.fallback, 0);
    assert.equal(result.error, null);
    assert.equal(service.incidentStatus.lastError, null);
    assert.equal(service.getIncidents().every((incident) => incident.ai.generated), true);
    assert.ok(calls > 1);
  });

  it('does not re-bill a cluster whose narrative is already cached', async () => {
    let calls = 0;
    const service = buildService({
      enabled: true,
      name: 'openrouter',
      activeModel: 'test/model',
      models: ['test/model'],
      status: { reason: null },
      async completeJson({ user }) {
        calls += 1;
        return payloadFor(JSON.parse(user));
      },
    });

    await service.refresh();
    const afterRefresh = calls;
    await service.regenerateIncidents();

    assert.equal(calls, afterRefresh, 'a settled incident costs nothing to re-parse');
  });

  it('reports the model that answered, not the head of the chain', async () => {
    const service = buildService({
      enabled: true,
      name: 'openrouter',
      activeModel: 'second/free',
      models: ['first/free', 'second/free'],
      status: { reason: null },
      async completeJson({ user }) { return payloadFor(JSON.parse(user)); },
    });

    await service.refresh();
    assert.equal(service.incidentStatus.model, 'second/free');
    assert.equal(service.getIncidents()[0].ai.model, 'second/free');
  });

  it('is a no-op with nothing to parse', async () => {
    const service = buildService({ enabled: false, name: 'off', status: { reason: 'off' } });
    assert.deepEqual(await service.regenerateIncidents(), {
      incidents: 0,
      generated: 0,
      fallback: 0,
      error: null,
    });
  });
});
