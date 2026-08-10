import { LINE_COLOR } from './lines';
import {
  BADGE_GROW_SELECTED,
  BADGE_HEIGHT,
  BADGE_RADIUS_TRAM,
  DENSITY_SIZES,
  DOT_SIZE,
  DOT_TAIL_HALF_BASE,
  DOT_TAIL_LENGTH,
  DOT_TAIL_OUTLINE,
  DOT_TAIL_SINK,
  TAIL_HALF_BASE,
  TAIL_LENGTH,
  TAIL_OUTLINE,
  TAIL_SINK,
  badgeWidthFor,
} from './vehicle-marker';

/**
 * The map itself: a plain Leaflet page.
 *
 * It is HTML rather than a native map component on purpose: a page any host can
 * render. The web build has no `react-native-maps` implementation, so this page
 * is the web map, drawn in a browser `<iframe>` for the preview; on native it
 * is the OpenStreetMap/fallback surface, hosted in a `WebView`. The native map
 * on iOS and Android is `react-native-maps` (see `native-map.tsx`).
 *
 * It deliberately mirrors `server/views/map.html`'s `renderVehicles()` rather
 * than reimplementing it: a `Map` of id → marker that is *moved* between polls,
 * never rebuilt. Rebuilding made the whole fleet blink every ten seconds, closed
 * whatever was open, and lost the selection.
 */

export type MapMessage =
  | { type: 'ready' }
  | { type: 'vehicle'; id: string }
  | { type: 'stop'; id: string; name: string }
  | { type: 'background' }
  | { type: 'moved'; lat: number; lon: number; zoom: number }
  | { type: 'viewport'; lat: number; lon: number; radiusMeters: number; zoom: number };

const PALETTE = JSON.stringify(LINE_COLOR);

export const WROCLAW_CENTER = { lat: 51.1079, lon: 17.0385, zoom: 13 };

export const mapHtml = (dark: boolean) => `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
<style>
  /*
   * Everything the theme touches is a variable.
   *
   * The page is generated once and the theme can change while it is up —
   * markers are not rebuilt for it, and neither is anything else. Baking a
   * colour in means setTheme cannot reach it: the page background stayed
   * light behind dark tiles, which showed through every time the tiles had
   * not painted yet.
   */
  :root {
    color-scheme: ${dark ? 'dark' : 'light'};
    --map-bg: ${dark ? '#000000' : '#f2f2f7'};
    /* The outline every marker is drawn with. */
    --ring: ${dark ? 'rgba(255,255,255,0.92)' : '#ffffff'};
    --chrome-bg: ${dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'};
    --chrome-fg: ${dark ? '#8e8e93' : '#6b7280'};
    --tooltip-bg: ${dark ? 'rgba(28,28,30,0.94)' : 'rgba(255,255,255,0.96)'};
    --tooltip-fg: ${dark ? '#f2f2f7' : '#1c1c1e'};
  }
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
  body { background: var(--map-bg); -webkit-tap-highlight-color: transparent; }
  .leaflet-container { background: var(--map-bg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

  /* Attribution has to stay, but it should not fight the UI for attention. */
  .leaflet-control-attribution {
    background: var(--chrome-bg) !important;
    color: var(--chrome-fg) !important;
    font-size: 9px !important;
    backdrop-filter: blur(8px);
    border-radius: 6px 0 0 0;
    padding: 1px 5px !important;
  }
  .leaflet-control-attribution a { color: var(--chrome-fg) !important; }

  /*
   * Upright transit labels: bearing belongs to the tail, never the text.
   *
   * A vehicle is one shape — a badge with a directional tail growing out of
   * its own outline — and src/lib/vehicle-marker.ts is the authority on where
   * the two meet, at each heading, for each badge width. Its constants are
   * interpolated below and its solver is mirrored in the script; the same
   * marker is drawn by native-map.tsx and by server/views/map.html.
   *
   * Every marker carries both forms — the labelled badge and the bare dot —
   * and a class on the root decides which one shows. That is what lets the
   * zoom tier and the de-collision pass below change hundreds of markers with
   * a classList toggle instead of rebuilding an icon each, which is the same
   * "move markers, don't rebuild them" rule the rest of this file follows.
   *
   * The box is fixed and generous here, unlike on the native surface where it
   * is also the hit target: nothing in it takes a pointer except the shape
   * itself, so a vehicle cannot swallow the click meant for its neighbour.
   */
  .vehicle {
    position: relative;
    width: 64px; height: 64px;
    pointer-events: none;
    transition: opacity 200ms ease-out;
    /* The dot every vehicle gets at district zoom. City zoom overrides it per
       marker with the size its cell's count earned. */
    --dot-size: ${DOT_SIZE}px;
  }

  .vehicle__bearing {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
  }

  /* The tail, drawn before the badge so the few pixels of it that sink inside
     the outline are covered and the two read as one shape. */
  .vehicle__tail,
  .vehicle__tail-edge {
    position: absolute;
    left: 50%;
    width: 0; height: 0;
    border-style: solid;
    border-color: transparent;
  }
  .vehicle__tail {
    top: var(--tail-top);
    margin-left: -${TAIL_HALF_BASE}px;
    border-width: 0 ${TAIL_HALF_BASE}px ${TAIL_LENGTH}px;
    border-bottom-color: var(--vehicle-color, #475569);
  }
  /* The badge's white keyline, continued around the tail. A tinted arrow on
     its own disappears over a road drawn in roughly that colour. */
  .vehicle__tail-edge {
    top: var(--tail-edge-top);
    margin-left: -${TAIL_HALF_BASE + TAIL_OUTLINE}px;
    border-width: 0 ${TAIL_HALF_BASE + TAIL_OUTLINE}px ${TAIL_LENGTH + TAIL_OUTLINE}px;
    border-bottom-color: var(--ring);
  }

  /*
   * Centred on the coordinate with margins rather than a transform: the marker
   * itself is transitioned while it glides, and a second transform inside it
   * is one more thing to keep out of that.
   */
  .vehicle__body {
    position: absolute;
    top: 50%; left: 50%;
    width: var(--badge-w); height: var(--badge-h);
    margin: calc(var(--badge-h) / -2) 0 0 calc(var(--badge-w) / -2);
    border-radius: var(--badge-r);
    box-sizing: border-box;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--vehicle-color, #475569);
    border: 1.5px solid var(--ring);
    box-shadow: 0 1px 3px rgba(0,0,0,${dark ? '0.36' : '0.24'});
    z-index: 2;
    pointer-events: auto;
  }

  /* Shape carries the mode as well as colour: two hues alone are no help to
     anyone who cannot separate them, and this map is read in sunlight. The
     badge's own radius comes from the geometry — square shoulders for a tram,
     a pill for a bus — and the dot says it as a fraction of whatever size it
     has been given, so it holds at every density step. */
  .vehicle--tram .vehicle__dot { border-radius: 25%; }

  .vehicle__label {
    color: #ffffff;
    font-size: 13px;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    /* Line numbers are read as a column of digits when markers stack up. */
    font-variant-numeric: tabular-nums;
  }
  .vehicle__label--long { font-size: 11px; letter-spacing: -0.04em; }

  .vehicle__dot {
    position: absolute;
    top: 50%; left: 50%;
    width: var(--dot-size); height: var(--dot-size);
    margin: calc(var(--dot-size) / -2) 0 0 calc(var(--dot-size) / -2);
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--vehicle-color, #475569);
    border: 2px solid var(--ring);
    box-shadow: 0 1px 3px rgba(0,0,0,0.28);
    display: none;
    pointer-events: auto;
  }

  /* The dot tiers: the badge gives way to a dot, and the tail comes with it at
     the smaller size a dot can carry. */
  .vehicle--dot .vehicle__body { display: none; }
  .vehicle--dot .vehicle__dot { display: block; }
  .vehicle--dot .vehicle__tail {
    top: var(--dot-tail-top);
    margin-left: -${DOT_TAIL_HALF_BASE}px;
    border-width: 0 ${DOT_TAIL_HALF_BASE}px ${DOT_TAIL_LENGTH}px;
  }
  .vehicle--dot .vehicle__tail-edge {
    top: var(--dot-tail-edge-top);
    margin-left: -${DOT_TAIL_HALF_BASE + DOT_TAIL_OUTLINE}px;
    border-width: 0 ${DOT_TAIL_HALF_BASE + DOT_TAIL_OUTLINE}px ${DOT_TAIL_LENGTH + DOT_TAIL_OUTLINE}px;
  }

  /*
   * City zoom: density instead of direction.
   *
   * One marker per cell survives and the rest are thinned out — the pile-up of
   * seven hundred overlapping dots is not a map of a tram network. But a
   * survivor that looks the same whether it stands for one bus or eight trams
   * throws away the one thing this scale is good for, so applyTier sizes it by
   * its cell's count. It carries no tail: at this scale the dot speaks for the
   * vehicles it swallowed as much as for itself, and a heading would be a claim
   * about them too.
   */
  .vehicle--small .vehicle__dot {
    --dot-size: var(--far-dot, ${DENSITY_SIZES[1]}px);
    border-width: var(--far-ring, 1.5px);
  }
  .vehicle--small .vehicle__bearing { display: none; }
  .vehicle--thinned { display: none; }

  /* The selected vehicle grows by real pixels — the geometry hands back a
     larger badge and re-solves the tail against it. Scaling the badge with a
     transform would slide it away from the tail joined to it, which is the one
     seam this marker cannot afford. */
  .vehicle--selected { z-index: 1000 !important; }
  .vehicle--selected .vehicle__body {
    border-width: 2.5px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.42), 0 0 0 3px rgba(255,255,255,0.28);
  }

  /* With one vehicle chosen the rest step back, so the eye lands on it and its
     route. It is one class on the pane — not a single marker is rebuilt for it,
     which is the whole reason it can be done on every selection. */
  .leaflet-vehicles-pane.is-focused .vehicle:not(.vehicle--selected) { opacity: 0.28; }

  /* Markers glide between polls instead of jumping — but only while *we* are
     the ones moving them.

     A blanket transition on the marker's transform is not that. Leaflet
     repositions every marker itself at the end of a zoom, from the animated
     pre-zoom coordinate space into the new one, and it removes its own
     leaflet-zoom-anim guard *before* it does — _onZoomTransitionEnd clears the
     class, then fires 'zoom', and every marker updates with the transition
     live. The un-animated viewreset path never sets that class at all. Either
     way the whole fleet was left sliding in from where it used to be for a full
     second
     after every zoom: vehicles a street or two off the rails they run on.
     is-gliding is added around a poll's own setLatLng calls and dropped the
     moment a zoom starts, so a zoom lands on the truth instead of racing it. */
  .leaflet-vehicles-pane.is-gliding .leaflet-marker-icon.vehicle-marker {
    transition: transform 1000ms linear;
  }

  /* Two hundred markers sliding across the screen every ten seconds is the
     large, unavoidable motion this setting exists to remove. */
  @media (prefers-reduced-motion: reduce) {
    .leaflet-marker-icon.vehicle-marker,
    .vehicle { transition: none !important; }
  }

  .stop-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--ring);
    border: 2px solid var(--line-color, #475569);
    box-shadow: 0 1px 3px rgba(0,0,0,0.45);
  }

  /*
   * A stop: the dot on the coordinate, its name under it.
   *
   * The name is drawn with a halo rather than on a chip, the way the base map
   * draws its own labels — dozens of filled pills turn a map into a list. Both
   * forms live in the DOM and a class picks between them, so zooming is a
   * class toggle and not a rebuilt icon.
   */
  .stop {
    position: relative;
    width: 104px; height: 42px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 6px;
    box-sizing: border-box;
    pointer-events: none;
  }
  .stop__dot {
    width: 13px; height: 13px;
    box-sizing: border-box;
    border-radius: 50%;
    background: #ffffff;
    border: 3.5px solid ${dark ? '#e5e5ea' : '#1C1C1E'};
    box-shadow: 0 1px 3px rgba(0,0,0,0.45);
    pointer-events: auto;
    cursor: pointer;
  }
  .stop__name {
    display: none;
    margin-top: 2px;
    max-width: 104px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    line-height: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: ${dark ? '#ffffff' : '#1C1C1E'};
    text-shadow:
      0 0 3px ${dark ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)'},
      0 0 3px ${dark ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)'};
    pointer-events: auto;
    cursor: pointer;
  }
  .stop--named .stop__name { display: block; }
  .stop--selected .stop__dot { transform: scale(1.25); border-width: 4px; }
  .stop--selected .stop__name { font-weight: 800; }
  .leaflet-marker-icon.stop-marker { z-index: 400 !important; }

  .user-dot {
    width: 16px; height: 16px; border-radius: 50%;
    background: #0a84ff;
    border: 3px solid #ffffff;
    box-shadow: 0 0 0 4px rgba(10,132,255,0.25), 0 2px 8px rgba(0,0,0,0.4);
  }

  .leaflet-tooltip {
    background: var(--tooltip-bg);
    color: var(--tooltip-fg);
    border: none;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 8px;
  }
  .leaflet-tooltip::before { display: none; }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function () {
  'use strict';

  var LINE_COLOR = ${PALETTE};
  var dark = ${dark ? 'true' : 'false'};

  /* Line and stop names come from upstream feeds, so nothing reaches the DOM
     as markup without going through here first. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function colorFor(type) { return LINE_COLOR[type] || LINE_COLOR.unknown; }

  /* --- the map ---------------------------------------------------------- */

  var map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
    // A tap should select a marker or clear the selection; it should never zoom.
    doubleClickZoom: false,
    tap: true,
  }).setView([${WROCLAW_CENTER.lat}, ${WROCLAW_CENTER.lon}], ${WROCLAW_CENTER.zoom});

  map.attributionControl.setPrefix(false);

  var tileUrl = 'https://{s}.basemaps.cartocdn.com/' + (dark ? 'dark_all' : 'light_all') + '/{z}/{x}/{y}{r}.png';
  var tiles = L.tileLayer(tileUrl, {
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    maxZoom: 19,
  }).addTo(map);

  // Above the stop markers (600) and below the tooltips (650).
  map.createPane('vehicles');
  map.getPane('vehicles').style.zIndex = 640;

  var routeLayer = L.layerGroup().addTo(map);
  var stopLayer = L.layerGroup().addTo(map);
  var vehicleLayer = L.layerGroup().addTo(map);
  var userMarker = null;

  /* --- talking to the app ----------------------------------------------- */

  function send(payload) {
    var message = JSON.stringify(payload);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(message);
    } else if (window.parent && window.parent !== window) {
      // The web preview renders this page in an iframe instead of a WebView.
      window.parent.postMessage(message, '*');
    }
  }

  /* --- vehicles ---------------------------------------------------------- */

  var markers = new Map();   // id -> { marker, key, lat, lon }
  var selectedId = null;
  var followId = null;

  /** Every stop marker on the layer, in the order it was added. */
  var stopMarkers = [];
  var selectedStopId = null;

  /* --- route progress: travelled vs remaining ----------------------------- */

  var OFF_ROUTE_METERS = 150;
  var BACKWARD_TOLERANCE_METERS = 80;
  var routePoints = null;         // [lat, lon][]
  var routeColor = null;
  var progressState = null;       // { segmentIndex, alongMeters, projLat, projLon } | null
  var progressVehicleId = null;   // vehicle the stored progress belongs to
  var progressLastVehicle = null; // { lat, lon } of the last projected fix
  var routePolylines = { halo: null, line: null, travel: null };

  var TRAM_TYPES = { tram: 1, tramSpecial: 1, tramTemporary: 1 };

  /* --- marker geometry ----------------------------------------------------
   *
   * Mirrors src/lib/vehicle-marker.ts, whose constants are interpolated here
   * so the two cannot drift on a number. The badge and its tail are one shape,
   * so the tail has to touch the badge's outline at every heading — and that
   * outline is a rounded rectangle, 12px from its centre due north and 19px
   * due east. A tail on a fixed orbit either floats off the short sides or is
   * buried in the long ones, which is what the chevron this replaced did.
   */
  var BOX_HALF = 32;
  var TAIL_LENGTH = ${TAIL_LENGTH};
  var TAIL_OUTLINE = ${TAIL_OUTLINE};
  var TAIL_SINK = ${TAIL_SINK};
  var DOT_SIZE = ${DOT_SIZE};
  var DOT_TAIL_LENGTH = ${DOT_TAIL_LENGTH};
  var DOT_TAIL_OUTLINE = ${DOT_TAIL_OUTLINE};
  var DOT_TAIL_SINK = ${DOT_TAIL_SINK};
  var DENSITY_SIZES = ${JSON.stringify(DENSITY_SIZES)};

  /** How big the one dot that survives a cell is, for the number it stands for. */
  function dotSizeForDensity(count) {
    if (count >= 8) return DENSITY_SIZES[3];
    if (count >= 4) return DENSITY_SIZES[2];
    if (count >= 2) return DENSITY_SIZES[1];
    return DENSITY_SIZES[0];
  }

  function badgeWidth(label) {
    var n = label.length;
    return n <= 2 ? ${badgeWidthFor('11')} : n === 3 ? ${badgeWidthFor('111')} : ${badgeWidthFor('1111')};
  }

  /**
   * Distance from the badge's centre to its outline, along a unit direction.
   *
   * A ray leaves a rounded rectangle either through a flat edge — when the
   * crossing lands on the straight part — or through a corner arc, which is
   * the quadratic for a ray hitting a circle centred on that corner.
   */
  function outlineDistance(ux, uy, a, b, r) {
    var x = Math.abs(ux), y = Math.abs(uy);
    var flatA = Math.max(0, a - r), flatB = Math.max(0, b - r);
    if (x > 0) {
      var tx = a / x;
      if (tx * y <= flatB) return tx;
    }
    if (y > 0) {
      var ty = b / y;
      if (ty * x <= flatA) return ty;
    }
    var along = x * flatA + y * flatB;
    var gap = flatA * flatA + flatB * flatB - r * r;
    return along + Math.sqrt(Math.max(0, along * along - gap));
  }

  /**
   * The custom properties the CSS above reads, for one vehicle's look.
   *
   * Both tails are placed here, the badge's and the dot's, because which one
   * shows is decided later by a class — the tier must never rebuild an icon.
   */
  function markerVars(label, tram, selected, heading) {
    var grow = selected ? ${BADGE_GROW_SELECTED} : 0;
    var w = badgeWidth(label) + grow * 2;
    var h = ${BADGE_HEIGHT} + grow * 2;
    var r = tram ? ${BADGE_RADIUS_TRAM} + grow : h / 2;
    var vars = '--badge-w:' + w + 'px;--badge-h:' + h + 'px;--badge-r:' + r + 'px;';
    if (!Number.isFinite(heading)) return vars;

    // Screen axes: x right, y down, heading 0 = north.
    var radians = (heading * Math.PI) / 180;
    var ux = Math.sin(radians), uy = -Math.cos(radians);
    var base = outlineDistance(ux, uy, w / 2, h / 2, r) - TAIL_SINK;
    // The dot is a circle for a bus and a 25%-rounded square for a tram, at
    // whatever size it is drawn — the same outline the CSS gives it.
    var dotR = tram ? DOT_SIZE * 0.25 : DOT_SIZE / 2;
    var dotBase = outlineDistance(ux, uy, DOT_SIZE / 2, DOT_SIZE / 2, dotR) - DOT_TAIL_SINK;
    return vars
      + '--tail-top:' + (BOX_HALF - base - TAIL_LENGTH) + 'px;'
      + '--tail-edge-top:' + (BOX_HALF - base - TAIL_LENGTH - TAIL_OUTLINE) + 'px;'
      + '--dot-tail-top:' + (BOX_HALF - dotBase - DOT_TAIL_LENGTH) + 'px;'
      + '--dot-tail-edge-top:' + (BOX_HALF - dotBase - DOT_TAIL_LENGTH - DOT_TAIL_OUTLINE) + 'px;';
  }

  /**
   * The marker, with both of its forms in the DOM.
   *
   * Which one is shown is decided later, by class, so a zoom change or a
   * de-collision pass never has to rebuild an icon.
   */
  function iconHtml(vehicle, selected) {
    var color = colorFor(vehicle.type);
    var chosen = selected ? ' vehicle--selected' : '';
    var tram = Boolean(TRAM_TYPES[vehicle.type]);
    var mode = tram ? ' vehicle--tram' : ' vehicle--bus';
    var label = String(vehicle.line == null ? '' : vehicle.line);
    var long = label.length > 3 ? ' vehicle__label--long' : '';
    // The drawn angle is the bucketed one, so it always matches the key that
    // decides whether the icon is rebuilt at all.
    var angle = headingAngle(vehicle);
    var bearing = angle === null
      ? ''
      : '<div class="vehicle__bearing" style="transform:rotate(' + angle + 'deg)">'
        + '<div class="vehicle__tail-edge"></div><div class="vehicle__tail"></div></div>';
    return '<div class="vehicle' + chosen + mode + '" style="--vehicle-color:' + color + ';'
      + markerVars(label, tram, selected, angle) + '">'
      + bearing
      + '<div class="vehicle__body">'
      + '<span class="vehicle__label' + long + '">'
      + escapeHtml(label) + '</span>'
      + '</div>'
      + '<div class="vehicle__dot"></div>'
      + '</div>';
  }

  /**
   * How the fleet is drawn, by how much of the city is on screen.
   *
   * The same three tiers the native surface uses, at the zoom levels that
   * correspond to its region spans: thinned dots across the whole city, all
   * dots across a district, labelled badges down a street.
   */
  function tierFor() {
    var zoom = map.getZoom();
    if (zoom <= 11) return 'far';
    if (zoom <= 13) return 'mid';
    return 'near';
  }

  /**
   * The heading, bucketed to 15° — and drawn at that angle, not the raw one.
   *
   * A degree of GPS jitter is not a change anyone can see on a 24px badge, and
   * rebuilding every icon on the screen for it every ten seconds is the cost
   * this avoids. Since the icon is only rebuilt when the bucket changes, the
   * bucket is also the only angle that can honestly be drawn.
   */
  function headingAngle(vehicle) {
    return Number.isFinite(vehicle.heading)
      ? (Math.round(vehicle.heading / 15) % 24) * 15
      : null;
  }

  /**
   * What the marker looks like, reduced to a string.
   *
   * The tier is deliberately *not* part of this: it is a class, not an icon.
   */
  function keyFor(vehicle, selected) {
    var angle = headingAngle(vehicle);
    return vehicle.line + '|' + vehicle.type + '|' + angle + '|' + (selected ? 1 : 0);
  }

  /**
   * One place that knows the marker's geometry.
   *
   * The box is fixed at BOX_HALF either way: nothing in it takes a pointer
   * except the badge and the dot, so its size costs no one a click.
   */
  function vehicleIcon(vehicle, selected) {
    return L.divIcon({
      className: 'vehicle-marker',
      html: iconHtml(vehicle, selected),
      iconSize: [BOX_HALF * 2, BOX_HALF * 2],
      iconAnchor: [BOX_HALF, BOX_HALF],
    });
  }

  /**
   * The glide, switched on only for the moves this page makes itself.
   *
   * Leaflet moves markers too — at the end of every zoom, and on every
   * viewreset — and those moves are a jump between two coordinate spaces, not a
   * vehicle travelling. Transitioning them drags the whole fleet across the
   * screen from its pre-zoom position. So the transition lives on a class that
   * is only on the pane while a poll's own setLatLng calls are being made, and
   * comes off the instant the map itself starts moving markers.
   */
  // Kept in step with GLIDE_MS in native-map.tsx and with the CSS above: the
  // same vehicle travelling the same way, whichever surface is drawing it.
  var GLIDE_MS = 1000;
  var glideTimer = null;

  function beginGlide() {
    var pane = map.getPane('vehicles');
    if (!pane) return;
    pane.classList.add('is-gliding');
    if (glideTimer) clearTimeout(glideTimer);
    glideTimer = setTimeout(endGlide, GLIDE_MS);
  }

  function endGlide() {
    if (glideTimer) { clearTimeout(glideTimer); glideTimer = null; }
    var pane = map.getPane('vehicles');
    if (pane) pane.classList.remove('is-gliding');
  }

  // A zoom mid-glide would otherwise animate from wherever the interrupted
  // glide had got to, in the old scale, to the new one.
  map.on('zoomstart', endGlide);
  map.on('viewreset', endGlide);

  /** The grid a marker has to have to itself, in screen pixels. */
  var THIN_CELL = 26;
  var LABEL_CELL = 46;

  /**
   * Decide, per marker, whether it is a badge, a dot, or not drawn at all.
   *
   * Pure class toggling on elements that already exist — no icon is rebuilt, so
   * this can run on every pan, zoom and poll. Markers are walked in id order so
   * the one that wins a cell is the same one from poll to poll; walking them in
   * whatever order the payload arrived in made the survivor change every ten
   * seconds and the map twinkled.
   */
  function applyTier() {
    var tier = tierFor();
    var cell = tier === 'far' ? THIN_CELL : LABEL_CELL;
    var taken = tier === 'mid' ? null : Object.create(null);

    var ids = Array.from(markers.keys()).sort(function (a, b) {
      // The selected vehicle is considered first, so it always wins its cell.
      if (a === selectedId) return -1;
      if (b === selectedId) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    // What each marker's cell is, and how crowded it is. At city zoom the
    // count is the whole point: the survivor is sized by how many it stands
    // for, so a busy corridor reads as a thicker string of beads instead of
    // looking exactly like an empty one.
    var cells = [];
    var counts = tier === 'far' ? Object.create(null) : null;
    for (var c = 0; c < ids.length; c++) {
      var owner = markers.get(ids[c]);
      if (!owner || !taken) { cells.push(null); continue; }
      var at = map.latLngToLayerPoint(owner.marker.getLatLng());
      var cellKey = Math.round(at.x / cell) + ':' + Math.round(at.y / cell);
      cells.push(cellKey);
      if (counts) counts[cellKey] = (counts[cellKey] || 0) + 1;
    }

    for (var i = 0; i < ids.length; i++) {
      var entry = markers.get(ids[i]);
      var element = entry && entry.marker.getElement();
      if (!element) continue;
      var root = element.firstElementChild;
      if (!root) continue;

      var free = true;
      var key = cells[i];
      if (key !== null) {
        free = !taken[key];
        taken[key] = 1;
      }

      var selected = ids[i] === selectedId;
      root.classList.toggle('vehicle--thinned', tier === 'far' && !free && !selected);
      root.classList.toggle('vehicle--small', tier === 'far');
      root.classList.toggle('vehicle--dot', tier !== 'near' || !(free || selected));

      if (counts && free) {
        // A style write, not a rebuilt icon — the same rule the classes follow.
        var size = dotSizeForDensity(counts[key]);
        root.style.setProperty('--far-dot', size + 'px');
        root.style.setProperty('--far-ring', (size >= 10 ? 2 : 1.5) + 'px');
      }
    }
  }

  function tooltipFor(vehicle) {
    var towards = vehicle.trip && (vehicle.trip.towards || vehicle.trip.headsign);
    return '<b>' + escapeHtml(vehicle.line) + '</b>' + (towards ? ' → ' + escapeHtml(towards) : '');
  }

  function tooltipKeyFor(vehicle) {
    var towards = vehicle.trip && (vehicle.trip.towards || vehicle.trip.headsign);
    return String(vehicle.line) + '|' + String(towards || '');
  }

  /**
   * Update the fleet in place.
   *
   * The icon is only rebuilt when it would actually look different — the
   * heading is bucketed to 15° because otherwise a degree of GPS jitter
   * redraws every marker on the screen on every poll.
   */
  function setVehicles(list) {
    var seen = new Set();

    // Everything below this line that moves a marker is a vehicle travelling,
    // so this is the one place the glide is allowed.
    beginGlide();

    for (var i = 0; i < list.length; i++) {
      var vehicle = list[i];
      if (!vehicle || !isFinite(vehicle.lat) || !isFinite(vehicle.lon)) continue;
      seen.add(vehicle.id);

      var selected = vehicle.id === selectedId;
      var key = keyFor(vehicle, selected);
      var tooltipKey = tooltipKeyFor(vehicle);
      var existing = markers.get(vehicle.id);

      if (!existing) {
        var marker = L.marker([vehicle.lat, vehicle.lon], {
          icon: vehicleIcon(vehicle, selected),
          // Their own pane, so the whole fleet can be dimmed with one class
          // and so vehicles always sit above the stops they pass.
          pane: 'vehicles',
          keyboard: false,
          riseOnHover: true,
        });
        marker.bindTooltip(tooltipFor(vehicle), { direction: 'top', offset: [0, -26] });
        marker.on('click', function (id) {
          return function (event) {
            // Without this the tap also reaches the map's own click handler,
            // which clears the very selection this is making.
            L.DomEvent.stopPropagation(event);
            selectVehicle(id);
            send({ type: 'vehicle', id: id });
          };
        }(vehicle.id));
        marker.addTo(vehicleLayer);
        // The vehicle is kept so selecting one can redraw it straight away,
        // without waiting for the next poll to come round.
        markers.set(vehicle.id, {
          marker: marker,
          key: key,
          lat: vehicle.lat,
          lon: vehicle.lon,
          tooltipKey: tooltipKey,
          vehicle: vehicle,
        });
      } else {
        if (existing.lat !== vehicle.lat || existing.lon !== vehicle.lon) {
          existing.marker.setLatLng([vehicle.lat, vehicle.lon]);
          existing.lat = vehicle.lat;
          existing.lon = vehicle.lon;
        }
        if (existing.key !== key) {
          existing.marker.setIcon(vehicleIcon(vehicle, selected));
          existing.key = key;
        }
        existing.vehicle = vehicle;
        if (existing.tooltipKey !== tooltipKey) {
          existing.marker.setTooltipContent(tooltipFor(vehicle));
          existing.tooltipKey = tooltipKey;
        }
      }

      if (followId && vehicle.id === followId) {
        map.panTo([vehicle.lat, vehicle.lon], { animate: true, duration: 0.6 });
      }
    }

    markers.forEach(function (entry, id) {
      if (seen.has(id)) return;
      vehicleLayer.removeLayer(entry.marker);
      markers.delete(id);
    });

    applyTier();

    // The selected vehicle may have moved, so re-project its progress along the
    // route. Guarded so the idle map does no work on every poll.
    if (selectedId) updateRouteSplit();
  }

  // Thinning and de-collision are decided in screen space, so both a zoom and a
  // pan change the answer. Neither rebuilds an icon.
  map.on('zoomend', applyTier);
  map.on('moveend', applyTier);
  map.on('zoomend', applyStopTier);
  map.on('moveend', applyStopTier);

  function selectVehicle(id) {
    var previous = selectedId;
    selectedId = id;

    // Dimming the rest is a class on the pane, so the fleet is untouched.
    var pane = map.getPane('vehicles');
    if (pane) pane.classList.toggle('is-focused', Boolean(id));

    // Only the two markers whose appearance changed are redrawn, and they are
    // redrawn now rather than on the next poll — otherwise the vehicle you
    // just tapped spends up to ten seconds dimmed along with everything else.
    [previous, id].forEach(function (target) {
      if (!target) return;
      var entry = markers.get(target);
      if (!entry || !entry.vehicle) return;
      var isSelected = target === id;
      entry.marker.setIcon(vehicleIcon(entry.vehicle, isSelected));
      entry.key = keyFor(entry.vehicle, isSelected);
    });

    // A selected vehicle is always drawn as a badge, whatever the tier and
    // whichever marker took its cell.
    applyTier();

    // A different vehicle (or a cleared selection) starts the progress state
    // over so the last split does not bleed onto a new route.
    if (id !== previous) resetProgress(id);
    updateRouteSplit();
  }

  /* --- route and stops ---------------------------------------------------- */

  function projectProgressOnRoute(points, lat, lon, previous) {
    var EARTH_R = 6371000;
    var DEG2RAD = Math.PI / 180;
    var n = points.length;
    if (n < 2) return null;

    var lat0 = points[0][0];
    var lon0 = points[0][1];
    var cosLat0 = Math.cos(lat0 * DEG2RAD);
    var scaleX = cosLat0 * EARTH_R * DEG2RAD;
    var scaleY = EARTH_R * DEG2RAD;

    function toLocal(p) {
      return { x: (p[1] - lon0) * scaleX, y: (p[0] - lat0) * scaleY };
    }
    function fromLocal(p) {
      return [lat0 + p.y / scaleY, lon0 + p.x / scaleX];
    }

    var local = [];
    var along = [];
    for (var i = 0; i < n; i++) {
      local[i] = toLocal(points[i]);
      along[i] = i > 0 ? along[i - 1] + Math.hypot(local[i].x - local[i - 1].x, local[i].y - local[i - 1].y) : 0;
    }

    var vx = (lon - lon0) * scaleX;
    var vy = (lat - lat0) * scaleY;

    function projectSegment(i) {
      var a = local[i];
      var b = local[i + 1];
      var abx = b.x - a.x;
      var aby = b.y - a.y;
      var len2 = abx * abx + aby * aby;
      var t, px, py;
      if (len2 === 0) {
        t = 0; px = a.x; py = a.y;
      } else {
        var apx = vx - a.x;
        var apy = vy - a.y;
        t = (apx * abx + apy * aby) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        px = a.x + abx * t;
        py = a.y + aby * t;
      }
      var perp = Math.hypot(vx - px, vy - py);
      var segLen = along[i + 1] - along[i];
      return { i: i, t: t, px: px, py: py, perp: perp, along: along[i] + segLen * t };
    }

    // Prefer the segments around the last projection, which is what stops a
    // jittery fix snapping to an earlier parallel stretch of the route.
    var best = null;
    if (previous) {
      var seg = previous.segmentIndex < 0 ? 0 : previous.segmentIndex > n - 2 ? n - 2 : previous.segmentIndex;
      var lo = Math.max(0, seg - 1);
      var hi = Math.min(n - 2, seg + 1);
      for (var k = lo; k <= hi; k++) {
        var r = projectSegment(k);
        if (!best || r.perp < best.perp) best = r;
      }
      if (!best || best.perp > OFF_ROUTE_METERS) best = null;
    }
    // Full scan as the fallback — finds a vehicle that moved past the window.
    if (!best) {
      best = projectSegment(0);
      for (var j = 1; j <= n - 2; j++) {
        var r2 = projectSegment(j);
        if (r2.perp < best.perp) best = r2;
      }
    }
    if (!best || best.perp > OFF_ROUTE_METERS) return null;

    var projGeo = fromLocal({ x: best.px, y: best.py });
    return {
      segmentIndex: best.i,
      fraction: best.t,
      projLat: projGeo[0],
      projLon: projGeo[1],
      distanceMeters: best.perp,
      alongMeters: best.along,
    };
  }

  function applyLatLngs(poly, pts) {
    if (!poly) return;
    poly.setLatLngs((pts || []).map(function (p) { return [p[0], p[1]]; }));
  }

  function resetProgress(id) {
    progressState = null;
    progressVehicleId = id;
    progressLastVehicle = null;
  }

  /**
   * Redraw the route as either a split travelled/remaining pair (when a vehicle
   * is selected and on the route) or as a full unsplit line. The persistent
   * polylines are rewritten with setLatLngs rather than rebuilt, so the
   * ten-second fleet poll never makes the line blink.
   */
  function updateRouteSplit() {
    if (!routePoints || !routePolylines.line || routePoints.length < 2) return;

    var entry = selectedId ? markers.get(selectedId) : null;
    var full = !entry || !isFinite(entry.lat) || !isFinite(entry.lon);

    // Nothing to do if the selected vehicle did not move since the last poll:
    // rewriting identical geometry every ten seconds is exactly the flicker
    // this page learned not to do with markers.
    if (!full && progressLastVehicle &&
        progressLastVehicle.lat === entry.lat && progressLastVehicle.lon === entry.lon) {
      return;
    }

    if (full) {
      routePolylines.travel.setLatLngs([]);
      applyLatLngs(routePolylines.halo, routePoints);
      applyLatLngs(routePolylines.line, routePoints);
      return;
    }

    progressLastVehicle = { lat: entry.lat, lon: entry.lon };
    var prev = progressVehicleId === selectedId ? progressState : null;
    var prevInput = prev ? { segmentIndex: prev.segmentIndex, alongMeters: prev.alongMeters } : null;
    var prog = projectProgressOnRoute(routePoints, entry.lat, entry.lon, prevInput);

    if (!prog) {
      // Off the route: draw it whole and wait to recover.
      routePolylines.travel.setLatLngs([]);
      applyLatLngs(routePolylines.halo, routePoints);
      applyLatLngs(routePolylines.line, routePoints);
      return;
    }
    if (prev && prog.alongMeters < prev.alongMeters - BACKWARD_TOLERANCE_METERS) {
      // Implausible backwards jump from GPS jitter: hold the last split point
      // so the travelled line never shrinks.
      prog = prev;
    }
    progressState = prog;
    progressVehicleId = selectedId;

    var seg = prog.segmentIndex;
    var proj = [prog.projLat, prog.projLon];
    var travelled = routePoints.slice(0, seg + 1).concat([proj]);
    var remaining = [proj].concat(routePoints.slice(seg + 1));
    applyLatLngs(routePolylines.travel, travelled);
    applyLatLngs(routePolylines.halo, remaining);
    applyLatLngs(routePolylines.line, remaining);
  }

  function setRoute(shape) {
    routeLayer.clearLayers();
    stopLayer.clearLayers();
    routePoints = null;
    resetProgress(selectedId);
    routePolylines = { halo: null, line: null, travel: null };
    if (!shape || !shape.points || !shape.points.length) return;

    var color = colorFor(shape.type);
    routeColor = color;

    // A halo under the line, in the opposite tone to the map rather than the
    // same one. A dark casing on a dark map hid the darker half of the palette
    // completely — line 249 in #3730A3 was a row of stop dots and no route.
    // The three polylines are created once and only their points are rewritten
    // on each poll, so selecting a moving vehicle never rebuilds the layers.
    routePolylines.halo = L.polyline([], {
      color: dark ? '#ffffff' : '#000000',
      weight: 6,
      opacity: dark ? 0.32 : 0.22,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);

    routePolylines.line = L.polyline([], {
      color: color,
      weight: 4,
      opacity: 1,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);

    routePolylines.travel = L.polyline([], {
      color: color,
      weight: 3,
      opacity: 0.24,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);

    (shape.stops || []).forEach(function (stop) {
      if (!isFinite(stop.lat) || !isFinite(stop.lon)) return;
      var marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: '<div class="stop-dot" style="--line-color:' + color + '"></div>',
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        }),
        keyboard: false,
      });
      marker.bindTooltip(escapeHtml(String(stop.name || '')), { direction: 'top', offset: [0, -8] });
      marker.on('click', function (event) {
        L.DomEvent.stopPropagation(event);
        send({ type: 'stop', id: String(stop.id), name: String(stop.name || '') });
      });
      marker.addTo(stopLayer);
    });

    if (shape.fit !== false) {
      try {
        map.fitBounds(L.polyline(shape.points).getBounds(), {
          paddingTopLeft: [40, 60],
          paddingBottomRight: [40, 320],
          maxZoom: 15,
        });
      } catch (error) { /* a degenerate shape is not worth a crash */ }
    }

    updateRouteSplit();
  }

  /**
   * The stops layer: a dot on the coordinate, the name under it.
   *
   * Both forms are in the DOM and a class decides which shows, the same way
   * the vehicles work, so the de-collision pass below is a class toggle and
   * never a rebuilt icon. Names are what the layer is for — a field of
   * anonymous dots tells a rider nothing they cannot already see.
   */
  function setStops(stops) {
    stopLayer.clearLayers();
    stopMarkers.length = 0;

    (stops || []).forEach(function (stop) {
      if (!isFinite(stop.lat) || !isFinite(stop.lon)) return;
      var name = String(stop.name || '');
      var marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: 'stop-marker',
          html: '<div class="stop"><div class="stop__dot"></div>'
            + '<div class="stop__name">' + escapeHtml(name) + '</div></div>',
          iconSize: [STOP_BOX_W, STOP_BOX_H],
          iconAnchor: [STOP_BOX_W / 2, STOP_DOT_CENTRE_Y],
        }),
        keyboard: false,
      });
      marker.on('click', function (event) {
        L.DomEvent.stopPropagation(event);
        send({ type: 'stop', id: String(stop.id), name: name });
      });
      marker.addTo(stopLayer);
      stopMarkers.push({ marker: marker, id: String(stop.id), name: name });
    });

    applyStopTier();
  }

  /** The box the stop marker occupies, and where its dot sits inside it. */
  var STOP_BOX_W = 104;
  var STOP_BOX_H = 42;
  var STOP_DOT_CENTRE_Y = 12;
  /** A stop name needs more room than a two-digit line badge. */
  var STOP_LABEL_CELL = 78;
  /** Below this the map is showing districts, and no name would fit anyway. */
  var STOP_LABEL_ZOOM = 15;

  /**
   * Which stops get their name, and which stay a dot.
   *
   * Two rules, in order. A place is named once — the stops endpoint answers
   * with one record per platform, so a junction came back as "Galeria
   * Dominikanska" five times over and was printed five times across the same
   * block. Then the same screen-cell trick the vehicles use, at a wider cell
   * because these are words. Every platform keeps its dot either way; the
   * selected stop wins both rules.
   */
  function applyStopTier() {
    var labelled = map.getZoom() >= STOP_LABEL_ZOOM;
    var takenCells = Object.create(null);
    var takenNames = Object.create(null);

    var ordered = stopMarkers.slice().sort(function (a, b) {
      if (a.id === selectedStopId) return -1;
      if (b.id === selectedStopId) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (var i = 0; i < ordered.length; i++) {
      var entry = ordered[i];
      var element = entry.marker.getElement();
      var root = element && element.firstElementChild;
      if (!root) continue;

      var free = true;
      if (labelled) {
        var point = map.latLngToLayerPoint(entry.marker.getLatLng());
        var cell = Math.round(point.x / STOP_LABEL_CELL) + ':' + Math.round(point.y / STOP_LABEL_CELL);
        // Prefixed so a stop actually named "12:8" cannot collide with a cell.
        var nameKey = 'n:' + entry.name;
        free = !takenCells[cell] && !takenNames[nameKey];
        if (free) {
          takenCells[cell] = 1;
          takenNames[nameKey] = 1;
        }
      }

      var selected = entry.id === selectedStopId;
      root.classList.toggle('stop--named', labelled && (free || selected));
      root.classList.toggle('stop--selected', selected);
    }
  }

  function setSelectedStop(id) {
    selectedStopId = id ? String(id) : null;
    applyStopTier();
  }

  function setUser(position) {
    if (!position || !isFinite(position.lat) || !isFinite(position.lon)) {
      if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
      return;
    }
    if (!userMarker) {
      userMarker = L.marker([position.lat, position.lon], {
        icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        keyboard: false,
        interactive: false,
        zIndexOffset: -100,
      }).addTo(map);
    } else {
      userMarker.setLatLng([position.lat, position.lon]);
    }
  }

  function setTheme(next) {
    if (next === dark) return;
    dark = next;

    // Nothing on the page is rebuilt for a theme change, so every themed
    // colour is repainted here through its variable.
    var root = document.documentElement.style;
    root.setProperty('--map-bg', dark ? '#000000' : '#f2f2f7');
    root.setProperty('--ring', dark ? 'rgba(255,255,255,0.92)' : '#ffffff');
    root.setProperty('--chrome-bg', dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)');
    root.setProperty('--chrome-fg', dark ? '#8e8e93' : '#6b7280');
    root.setProperty('--tooltip-bg', dark ? 'rgba(28,28,30,0.94)' : 'rgba(255,255,255,0.96)');
    root.setProperty('--tooltip-fg', dark ? '#f2f2f7' : '#1c1c1e');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

    map.removeLayer(tiles);
    tiles = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/' + (dark ? 'dark_all' : 'light_all') + '/{z}/{x}/{y}{r}.png',
      { attribution: '&copy; OpenStreetMap, &copy; CARTO', maxZoom: 19 }
    ).addTo(map);
  }

  /* --- commands from the app --------------------------------------------- */

  function handle(raw) {
    var message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (error) { return; }
    if (!message || !message.type) return;

    switch (message.type) {
      case 'vehicles': setVehicles(message.vehicles || []); break;
      case 'route': setRoute(message.shape); break;
      case 'stops':
        setStops(message.stops || []);
        setSelectedStop(message.selectedId || null);
        break;
      case 'selectStop': setSelectedStop(message.id || null); break;
      case 'user': setUser(message.position); break;
      case 'theme': setTheme(Boolean(message.dark)); break;
      case 'select':
        selectVehicle(message.id || null);
        followId = message.follow ? message.id : null;
        if (message.id && markers.has(message.id)) {
          var entry = markers.get(message.id);
          if (message.center !== false) map.panTo([entry.lat, entry.lon], { animate: true });
        }
        break;
      case 'center':
        map.setView([message.lat, message.lon], message.zoom || map.getZoom(), { animate: message.animate !== false });
        break;
      default: break;
    }
  }

  window.__wroclive = { handle: handle };
  // The web host polls for this object's existence as its readiness signal
  // (that, not a load event, is the real precondition for posting anything).
  // Commands themselves arrive on the message channel: the native WebView
  // dispatches a MessageEvent on window or document, the iframe preview posts
  // across frames. The handlers exist purely so the page's handle is the one
  // entry point for every host - keep them in step with live-map.tsx and
  // live-map.web.tsx.
  window.addEventListener('message', function (event) { handle(event.data); });
  document.addEventListener('message', function (event) { handle(event.data); });

  map.on('click', function () {
    selectVehicle(null);
    followId = null;
    send({ type: 'background' });
  });

  map.on('moveend', function () {
    var center = map.getCenter();
    send({ type: 'moved', lat: center.lat, lon: center.lng, zoom: map.getZoom() });

    // The radius that covers the corners of the screen, not just its middle:
    // a stops request built from the shorter axis leaves gaps at the edges the
    // rider can plainly see.
    var bounds = map.getBounds();
    var diagonal = bounds.getNorthWest().distanceTo(bounds.getSouthEast());
    send({
      type: 'viewport',
      lat: center.lat,
      lon: center.lng,
      radiusMeters: Math.round(diagonal / 2),
      zoom: map.getZoom(),
    });
  });

  send({ type: 'ready' });
})();
</script>
</body>
</html>`;
