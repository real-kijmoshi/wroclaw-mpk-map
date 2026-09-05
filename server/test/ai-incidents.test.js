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
