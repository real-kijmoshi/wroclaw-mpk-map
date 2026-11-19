'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const PLUGIN = path.join(__dirname, '..', '..', 'wroclive', 'plugins', 'with-widget-stop-picker.js');

/**
 * The plugin requires `expo/config-plugins`, which the server does not
 * install; only `patchWidgetSource()` is under test, so the import is stubbed.
 */
function loadPlugin() {
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'expo/config-plugins') return { withFinalizedMod: (config) => config };
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[PLUGIN];
    return require(PLUGIN);
  } finally {
    Module._load = original;
  }
}

/** The parts of the Swift `expo-widgets` 57 generates for `Departures` that the plugin rewrites. */
const GENERATED = `
struct DeparturesConfigurationAppIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Przystanek Configuration"

  @Parameter(title: "Przystanek", default: "")
  var stop: String
}

struct DeparturesTimelineProvider: AppIntentTimelineProvider {
  func timeline(for configuration: DeparturesConfigurationAppIntent, in context: Context) async -> Timeline<DeparturesTimelineEntry> {
    let entries = self.parseTimeline(configuration: configuration)
    let timeline = Timeline<DeparturesTimelineEntry>(entries: entries, policy: .atEnd)
    return timeline
  }
}

struct DeparturesEntryView: View {
  private var widgetEnvironment: [String: Any] {
    env["configuration"] = [
      "stop": entry.configuration.stop
    ]
    return env
  }
}
`;

describe('widget stop picker plugin', () => {
  it('turns the stop into a picker entity', () => {
    const { patchWidgetSource } = loadPlugin();
    const patched = patchWidgetSource(GENERATED);
    assert.match(patched, /var stop: DeparturesStopEntity\?/);
    assert.match(patched, /"stop": entry\.configuration\.stop\?\.id \?\? ""/);
    assert.match(patched, /struct DeparturesStopQuery: EntityQuery/);
  });

  it('fetches the board itself and comes back on a schedule', () => {
    const { patchWidgetSource } = loadPlugin();
    // `.never` was right while the provider could only re-read what the app
    // wrote; the widget then sat on that until iOS ran the app again.
    const patched = patchWidgetSource(GENERATED);
    assert.match(patched, /DeparturesLiveFetch\.entries\(chosen: configuration\.stop\?\.id/);
    assert.match(patched, /policy: \.after\(reloadAt\)/);
    assert.doesNotMatch(patched, /policy: \.atEnd/);
    assert.match(patched, /enum DeparturesLiveFetch/);
  });

  it("draws the app's line colours, read from lines.ts", () => {
    const { patchWidgetSource, lineColors } = loadPlugin();
    const colors = lineColors(path.join(__dirname, '..', '..', 'wroclive'));
    assert.equal(colors.tram, '#0B5FBF');
    assert.equal(colors.bus, '#B91C1C');
    assert.ok(colors.unknown);
    const patched = patchWidgetSource(GENERATED, colors);
    for (const [type, color] of Object.entries(colors)) assert.ok(patched.includes(`"${type}": "${color}"`), type);
  });

  it('mirrors the timeline constants of widget-timeline.ts', () => {
    const { patchWidgetSource } = loadPlugin();
    const patched = patchWidgetSource(GENERATED);
    const fs = require('node:fs');
    const timeline = fs.readFileSync(path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'widget-timeline.ts'), 'utf8');
    const ts = (name) => Number(new RegExp(`${name} = ([\\d_]+)`).exec(timeline)[1].replace(/_/g, ''));
    assert.match(patched, new RegExp(`countdownMinutes = ${ts('COUNTDOWN_MINUTES')}\\n`));
    assert.match(patched, new RegExp(`departedGrace: Double = ${ts('DEPARTED_GRACE_MS').toLocaleString('en').replace(/,/g, '_')}\\n`));
  });

  it('is idempotent and fails loudly when the generated text moves', () => {
    const { patchWidgetSource } = loadPlugin();
    const once = patchWidgetSource(GENERATED);
    assert.equal(patchWidgetSource(once), once);
    assert.throws(
      () => patchWidgetSource(GENERATED.replace('policy: .atEnd', 'policy: .after(date)')),
      /timeline policy/,
    );
  });
});
