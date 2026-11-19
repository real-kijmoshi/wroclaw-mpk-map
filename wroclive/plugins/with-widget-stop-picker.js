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
 * - the parameter becomes a `DeparturesStopEntity?`,
 * - the environment hands the layout its `id`, and
 * - the timeline provider fetches the configured stop's board itself (see
 *   `POLICY_AFTER` and `liveFetchSource()`),
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

/**
 * `expo-widgets` asks WidgetKit to come back `.atEnd`. The provider can only
 * re-read what the app last wrote, so half an hour after the app last ran it
 * handed back the same timeline, every entry in the past — and WidgetKit
 * asked again, every few minutes, all night. Each of those asks spends the
 * widget's daily reload budget; once it is gone, the reloads the background
 * refresh requests are dropped too, and the widget sat on the last entry's
 * clock times with fresh data waiting for it. Every write the app makes
 * already reloads the widget (`updateTimeline` calls `reloadTimelines`), so
 * WidgetKit never needs to ask on its own.
 */
const POLICY_BEFORE =
  'let entries = self.parseTimeline(configuration: configuration)\n    let timeline = Timeline<DeparturesTimelineEntry>(entries: entries, policy: .atEnd)';
/**
 * …which was right while the provider could only re-read. It now fetches
 * (`DeparturesLiveFetch` below): each reload asks the API for the configured
 * stop's board and builds the entries itself, then asks to come back in
 * `refreshInterval`. WidgetKit spaces those to its own budget, so this is
 * "every quarter hour at best", not a promise. A fetch that fails, or a
 * timeline the app wrote minutes ago, falls back to what the app stored.
 */
const POLICY_AFTER = `let reloadAt = Date().addingTimeInterval(DeparturesLiveFetch.refreshInterval)
    if let fresh = await DeparturesLiveFetch.entries(chosen: configuration.stop?.id ?? "", configuration: configuration) {
      return Timeline<DeparturesTimelineEntry>(entries: fresh, policy: .after(reloadAt))
    }
    let entries = self.parseTimeline(configuration: configuration)
    let timeline = Timeline<DeparturesTimelineEntry>(entries: entries, policy: .after(reloadAt))`;
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

/**
 * The line colours, read out of `src/lib/lines.ts` at prebuild so the Swift
 * copy cannot drift from the app's (invariant 11). Fails the prebuild if the
 * table moves rather than drawing every badge grey.
 */
function lineColors(projectRoot) {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'lib', 'lines.ts'), 'utf8');
  const block = /export const LINE_COLOR[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  const pairs = block ? [...block[1].matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)] : [];
  if (!pairs.some(([, type]) => type === 'unknown')) {
    throw new Error('with-widget-stop-picker: could not read LINE_COLOR from src/lib/lines.ts');
  }
  return Object.fromEntries(pairs.map(([, type, color]) => [type, color]));
}

/**
 * The widget fetching its own board, so it moves on with the app closed.
 *
 * The app leaves, in the timeline's first entry, the API address and each
 * stop's platform ids (`fetch`, written by `syncDeparturesWidget()`); this
 * fetches the configured one's departures exactly as `getDeparturesForStops()`
 * and `getJourneyDepartures()` do, turns them into the rows `widgetRows()`
 * makes, and lays them out the way `timelineSlots()` does — one stop, so no
 * byte budget. Every entry carries only that stop; the picker reads the
 * stored timeline, not these.
 */
function liveFetchSource(colors) {
  const table = Object.entries(colors)
    .map(([type, color]) => `    ${JSON.stringify(type)}: ${JSON.stringify(color)},`)
    .join('\n');
  return `
// Added by plugins/with-widget-stop-picker.js — the widget fetching its own
// departures between the app's writes. Mirrors widgets.ios.ts and
// widget-timeline.ts; keep them in step.
enum DeparturesLiveFetch {
  static let refreshInterval: TimeInterval = 15 * 60
  /** A timeline the app wrote this recently is used as it is. */
  static let freshFor: Double = 5 * 60_000
  static let countdownMinutes = 30
  static let maxEntries = 400
  static let rowsPerEntry = 7
  static let departedGrace: Double = 30_000
  static let limit = 300
  static let minute: Double = 60_000
  static let lineColors: [String: String] = [
${table}
  ]

  static func entries(chosen: String, configuration: DeparturesConfigurationAppIntent) async -> [DeparturesTimelineEntry]? {
    guard
      let timeline = WidgetsStorage.getArray(forKey: "__expo_widgets_${WIDGET}_timeline"),
      let first = timeline.first as? [String: Any],
      let props = first["props"] as? [String: Any],
      let fetch = props["fetch"] as? [String: Any],
      let api = fetch["api"] as? String,
      let sources = fetch["sources"] as? [String: Any],
      let stops = props["stops"] as? [[String: Any]]
    else { return nil }
    let nowMs = Date().timeIntervalSince1970 * 1000
    if let updated = (props["updatedAt"] as? NSNumber)?.doubleValue, nowMs - updated < freshFor { return nil }
    guard
      var stop = chosen.isEmpty ? stops.first : stops.first(where: { ($0["id"] as? String) == chosen }),
      let id = stop["id"] as? String,
      let source = sources[id] as? [String: Any],
      let ids = source["ids"] as? [String], !ids.isEmpty,
      let departures = await board(api: api, ids: ids, to: source["to"] as? [String])
    else { return nil }

    let rows = departures.map { row($0, nowMs: nowMs) }
    let times = rows.compactMap { ($0["at"] as? Double) }
    if let last = times.last { stop["until"] = clock(last) } else { stop.removeValue(forKey: "until") }
    var base = props
    base.removeValue(forKey: "fetch")
    base["favourites"] = [[String: Any]]()
    base["updatedAt"] = nowMs
    return slots(nowMs: nowMs, departures: times).map { slot in
      let listed: [[String: Any]] = slot.expired
        ? []
        : Array(rows.filter { (($0["at"] as? Double) ?? 0) >= slot.date - departedGrace }.prefix(rowsPerEntry))
      var entryStop = stop
      entryStop["rows"] = listed
      var entryProps = base
      entryProps["final"] = slot.final
      entryProps["expired"] = slot.expired
      entryProps["stops"] = [entryStop]
      return DeparturesTimelineEntry(
        date: Date(timeIntervalSince1970: slot.date / 1000),
        name: "${WIDGET}",
        props: entryProps,
        entryIndex: nil,
        configuration: configuration
      )
    }
  }

  /** Every platform's board, merged; nil when none answered. */
  static func board(api: String, ids: [String], to: [String]?) async -> [[String: Any]]? {
    var query = "limit=\\(limit)&within=1440"
    if let to, !to.isEmpty { query += "&to=" + to.prefix(20).map(escape).joined(separator: ",") }
    // Bodies cross the task boundary as Data, which is Sendable; parsed after.
    let bodies = await withTaskGroup(of: Data?.self) { group -> [Data] in
      for id in Set(ids) {
        group.addTask { await load("\\(api)/stop/\\(escape(id))/departures?\\(query)") }
      }
      var answered: [Data] = []
      for await body in group { if let body { answered.append(body) } }
      return answered
    }
    let boards = bodies.compactMap { body -> [[String: Any]]? in
      guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
      return json["departures"] as? [[String: Any]]
    }
    if boards.isEmpty { return nil }
    let trip = to != nil
    var seen = Set<String>()
    let merged = boards.joined().filter { departure in
      // A trip keeps only what reaches the destination; an older server
      // that ignored ?to= leaves no arrivals, so nothing — as in the app.
      if trip && departure["arrivalInSeconds"] == nil { return false }
      let key = trip
        ? "\\(departure["tripId"] ?? "")|\\(departure["departure"] ?? "")"
        : "\\(departure["tripId"] ?? "")|\\(departure["line"] ?? "")|\\(departure["departure"] ?? "")"
      return seen.insert(key).inserted
    }
    return Array(merged.sorted { number($0["inSeconds"]) < number($1["inSeconds"]) }.prefix(limit))
  }

  static func load(_ url: String) async -> Data? {
    guard let url = URL(string: url) else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 12)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    guard
      let result = try? await URLSession.shared.data(for: request),
      (result.1 as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return result.0
  }

  /** \`widgetRows()\` for one departure: \`departureSeconds()\` and \`arrivalSeconds()\`. */
  static func row(_ departure: [String: Any], nowMs: Double) -> [String: Any] {
    let scheduled = number(departure["inSeconds"])
    let live = (departure["realtime"] as? Bool) == true && departure["predictedInSeconds"] is NSNumber
    let seconds = live ? number(departure["predictedInSeconds"]) : scheduled
    let type = departure["type"] as? String ?? "unknown"
    var row: [String: Any] = [
      "line": departure["line"] as? String ?? "",
      "color": lineColors[type] ?? lineColors["unknown"] ?? "#475569",
      "tram": type.hasPrefix("tram"),
      "headsign": departure["headsign"] as? String ?? "",
      "at": nowMs + seconds * 1000,
      "live": live,
    ]
    if departure["arrivalInSeconds"] is NSNumber {
      row["arriveAt"] = nowMs + (number(departure["arrivalInSeconds"]) + seconds - scheduled) * 1000
    }
    return row
  }

  /** \`timelineSlots()\`: a countdown a minute for half an hour, then one entry per departure leaving. */
  static func slots(nowMs: Double, departures: [Double]) -> [(date: Double, final: Bool, expired: Bool)] {
    let start = (nowMs / minute).rounded(.down) * minute
    let countdownEnd = start + Double(countdownMinutes) * minute
    var out: [(date: Double, final: Bool, expired: Bool)] = (0..<countdownMinutes).map {
      (date: start + Double($0) * minute, final: false, expired: false)
    }
    let changes = Set(departures.map { (($0 + departedGrace) / minute).rounded(.down) * minute + minute })
      .filter { $0 > countdownEnd }
      .sorted()
    let room = maxEntries - countdownMinutes - 2
    out.append((date: countdownEnd, final: true, expired: false))
    for date in changes.prefix(room) { out.append((date: date, final: true, expired: false)) }
    if changes.count > room {
      out.append((date: changes[room], final: true, expired: true))
    } else {
      out[out.count - 1].expired = true
    }
    return out
  }

  static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }

  static func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
  }

  static func clock(_ ms: Double) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
  }
}
`;
}

function patchWidgetSource(source, colors = { unknown: '#475569' }) {
  if (source.includes('struct DeparturesStopEntity')) return source;
  for (const [label, anchor] of [
    ['parameter', PARAMETER_BEFORE],
    ['environment', ENVIRONMENT_BEFORE],
    ['timeline policy', POLICY_BEFORE],
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
      .replace(POLICY_BEFORE, POLICY_AFTER)
      .replace(TITLE_BEFORE, TITLE_AFTER) +
    ENTITY +
    liveFetchSource(colors)
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
      const colors = lineColors(mod.modRequest.projectRoot);
      fs.writeFileSync(file, patchWidgetSource(fs.readFileSync(file, 'utf8'), colors));
      return mod;
    },
  ]);
}

module.exports = withWidgetStopPicker;
module.exports.patchWidgetSource = patchWidgetSource;
module.exports.lineColors = lineColors;
