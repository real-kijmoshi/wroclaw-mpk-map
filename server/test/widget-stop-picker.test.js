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

  it('never asks WidgetKit to come back for a timeline only the app can refresh', () => {
    const { patchWidgetSource } = loadPlugin();
    // `.atEnd` re-read the same, all-past timeline every few minutes after
    // the app last ran and spent the reload budget the background refresh needs.
    const patched = patchWidgetSource(GENERATED);
    assert.match(patched, /policy: \.never\)/);
    assert.doesNotMatch(patched, /policy: \.atEnd/);
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
