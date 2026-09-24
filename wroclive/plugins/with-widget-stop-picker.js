const fs = require('fs');
const path = require('path');
const { withFinalizedMod } = require('expo/config-plugins');

/**
 * Makes the Departures widget's "Przystanek" setting a list of starred stops,
 * by name.
 *
 * `expo-widgets` can only declare string, number, boolean and *static* enum
 * parameters, which is why the widget used to offer "Pierwszy / Drugi /
 * Trzeci": a rider had to remember what order they had starred things in to
 * know which stop a widget would show. WidgetKit's own answer is an
 * `AppEntity` whose query is answered at edit time, and that needs Swift.
 *
 * So `app.json` declares the parameter as a plain string called `stop`, and
 * this plugin rewrites the file `expo-widgets` generated from it:
 *
 * - the parameter becomes a `DeparturesStopEntity?`, and
 * - the environment hands the layout its `id`,
 *
 * and appends the entity and its query. The query reads the starred stops out
 * of the widget's own timeline (`props.favourites`, written by
 * `syncDeparturesWidget()`), from the app group `expo-widgets` already shares
 * with the extension, so it needs no storage of its own and no new
 * entitlement.
 *
 * It is a *finalized* mod because it must run after `expo-widgets` writes the
 * file, and dangerous mods run in reverse order of registration — listing it
 * after `expo-widgets` in `app.json` made it run first and find nothing. It
 * fails the prebuild if the generated text has moved rather than shipping a
 * widget that silently lost its picker. Without it the setting is still a text
 * field, and the layout matches a typed stop name — degraded, not broken.
 */

const WIDGET = 'Departures';

const PARAMETER_BEFORE = '@Parameter(title: "Przystanek", default: "")\n  var stop: String';
const PARAMETER_AFTER = '@Parameter(title: "Przystanek")\n  var stop: DeparturesStopEntity?';
const ENVIRONMENT_BEFORE = '"stop": entry.configuration.stop\n';
const ENVIRONMENT_AFTER = '"stop": entry.configuration.stop?.id ?? ""\n';
const TITLE_BEFORE = '"Przystanek Configuration"';
const TITLE_AFTER = '"Przystanek"';

const ENTITY = `
// Added by plugins/with-widget-stop-picker.js — the rider's starred stops,
// offered by name in the widget's "Przystanek" setting.
struct DeparturesStopEntity: AppEntity {
  let id: String
  let name: String
  let detail: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Przystanek"
  static var defaultQuery = DeparturesStopQuery()

  var displayRepresentation: DisplayRepresentation {
    if detail.isEmpty {
      return DisplayRepresentation(title: "\\(name)")
    }
    return DisplayRepresentation(title: "\\(name)", subtitle: "\\(detail)")
  }
}

struct DeparturesStopQuery: EntityQuery {
  /// Read from the timeline the app last wrote. Every entry carries the same
  /// list, so the first one is enough.
  static func starred() -> [DeparturesStopEntity] {
    guard
      let timeline = WidgetsStorage.getArray(forKey: "__expo_widgets_${WIDGET}_timeline"),
      let entry = timeline.first as? [String: Any],
      let props = entry["props"] as? [String: Any],
      let list = props["favourites"] as? [[String: Any]]
    else { return [] }
    return list.compactMap { item in
      guard let id = item["id"] as? String, let name = item["name"] as? String else { return nil }
      return DeparturesStopEntity(id: id, name: name, detail: item["detail"] as? String ?? "")
    }
  }

  func entities(for identifiers: [String]) async throws -> [DeparturesStopEntity] {
    let all = DeparturesStopQuery.starred()
    // A stop unstarred since the widget was set up keeps its id, so the widget
    // can say so instead of quietly switching to a different stop.
    return identifiers.map { id in
      all.first { $0.id == id } ?? DeparturesStopEntity(id: id, name: "Usunięty z ulubionych", detail: "")
    }
  }

  func suggestedEntities() async throws -> [DeparturesStopEntity] {
    DeparturesStopQuery.starred()
  }

  func defaultResult() async -> DeparturesStopEntity? {
    DeparturesStopQuery.starred().first
  }
}
`;

function patchWidgetSource(source) {
  if (source.includes('struct DeparturesStopEntity')) return source;
  for (const [label, anchor] of [
    ['parameter', PARAMETER_BEFORE],
    ['environment', ENVIRONMENT_BEFORE],
  ]) {
    if (!source.includes(anchor)) {
      throw new Error(
        `with-widget-stop-picker: the ${label} expo-widgets generated for ${WIDGET} has changed ` +
          `(looked for ${JSON.stringify(anchor)}). Update the plugin to match the new output.`,
      );
    }
  }
  return (
    source
      .replace(PARAMETER_BEFORE, PARAMETER_AFTER)
      .replace(ENVIRONMENT_BEFORE, ENVIRONMENT_AFTER)
      .replace(TITLE_BEFORE, TITLE_AFTER) + ENTITY
  );
}

/** The extension's folder is named by `expo-widgets`; find it by the file it wrote. */
function findWidgetSource(iosRoot) {
  for (const entry of fs.readdirSync(iosRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(iosRoot, entry.name, `${WIDGET}.swift`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function withWidgetStopPicker(config) {
  return withFinalizedMod(config, [
    'ios',
    async (mod) => {
      const file = findWidgetSource(mod.modRequest.platformProjectRoot);
      if (!file) {
        throw new Error(
          `with-widget-stop-picker: no ${WIDGET}.swift under ios/ — is expo-widgets still configured with it?`,
        );
      }
      fs.writeFileSync(file, patchWidgetSource(fs.readFileSync(file, 'utf8')));
      return mod;
    },
  ]);
}

module.exports = withWidgetStopPicker;
module.exports.patchWidgetSource = patchWidgetSource;
