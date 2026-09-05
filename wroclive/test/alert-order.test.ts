import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Alert } from '../src/lib/api.ts';
import { isResolvedAlert, orderAlertsForSelectedLines } from '../src/lib/alert-order.ts';

const alert = (id: string, affected: string[], content = 'Utrudnienia w ruchu'): Alert => ({
  id,
  title: id,
  content,
  affected,
  url: null,
  timestamp: 0,
  source: 'test',
  types: {},
});

describe('isResolvedAlert', () => {
  it('recognises the ways a notice says the disruption is over', () => {
    for (const content of [
      'Ruch przywrócony na ulicy Legnickiej',
      'Ruch normalny',
      'Kursowanie wznowione',
      'Utrudnienia zakończone',
      'Odwołane utrudnienia',
    ]) {
      assert.ok(isResolvedAlert(alert('x', [], content)), content);
    }
  });

  it('leaves an active disruption active', () => {
    for (const content of [
      'Utrudnienia w ruchu tramwajów',
      'Awaria na skrzyżowaniu',
      'Zmiana trasy linii 4',
    ]) {
      assert.ok(!isResolvedAlert(alert('x', [], content)), content);
    }
  });

  it('reads the title as well as the body', () => {
    const titled = { ...alert('x', [], ''), title: 'Ruch przywrócony' };
    assert.ok(isResolvedAlert(titled));
  });
});

describe('orderAlertsForSelectedLines', () => {
  const disruption = alert('a', ['4']);
  const other = alert('b', ['33']);
  const resolved = alert('c', ['4'], 'Ruch przywrócony');

  it('is one unheaded section when nothing is selected', () => {
    const sections = orderAlertsForSelectedLines([disruption, other], []);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
    assert.equal(sections[0].alerts.length, 2);
  });

  it('is one unheaded section when no alert touches the selection', () => {
    // Heading a single section "Pozostałe" would imply a "Twoje linie" section
    // that is not there.
    const sections = orderAlertsForSelectedLines([other], ['4']);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
  });

  it('puts the selected lines first when some are relevant', () => {
    const sections = orderAlertsForSelectedLines([other, disruption], ['4']);
    assert.deepEqual(
      sections.map((section) => section.heading),
      ['Twoje linie', 'Pozostałe aktywne'],
    );
    assert.deepEqual(sections[0].alerts, [disruption]);
    assert.deepEqual(sections[1].alerts, [other]);
  });

  it('keeps a single headed section when everything is relevant', () => {
    const sections = orderAlertsForSelectedLines([disruption], ['4']);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, 'Twoje linie');
  });

  it('sinks resolved notices below the active ones', () => {
    const sections = orderAlertsForSelectedLines([resolved, disruption], ['4']);
    assert.deepEqual(
      sections.map((section) => section.heading),
      ['Twoje linie', 'Przywrócono ruch'],
    );
    assert.deepEqual(sections[0].alerts, [disruption], 'resolved must not lead');
    assert.deepEqual(sections[1].alerts, [resolved]);
  });

  it('sinks resolved notices even with nothing selected', () => {
    const [section] = orderAlertsForSelectedLines([resolved, disruption], []);
    assert.deepEqual(section.alerts, [disruption, resolved]);
  });

  it('matches a line whatever case it arrives in', () => {
    const nightLine = alert('n', ['n']);
    const sections = orderAlertsForSelectedLines([nightLine], ['N']);
    assert.equal(sections[0].heading, 'Twoje linie');
  });

  it('never drops an alert', () => {
    const all = [disruption, other, resolved];
    for (const selected of [[], ['4'], ['33'], ['4', '33'], ['999']]) {
      const shown = orderAlertsForSelectedLines(all, selected).flatMap((s) => s.alerts);
      assert.equal(shown.length, all.length, `selection ${JSON.stringify(selected)}`);
      assert.deepEqual(new Set(shown.map((a) => a.id)), new Set(all.map((a) => a.id)));
    }
  });
});
