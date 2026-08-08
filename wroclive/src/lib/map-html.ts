import { LINE_COLOR, VEHICLE_BORDER_COLOR, VEHICLE_COLOR } from './lines';

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
  | { type: 'moved'; lat: number; lon: number; zoom: number };

const PALETTE = JSON.stringify(LINE_COLOR);
const VEHICLE_PALETTE = JSON.stringify(VEHICLE_COLOR);
const VEHICLE_BORDER_PALETTE = JSON.stringify(VEHICLE_BORDER_COLOR);

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

  /* Paper-map vehicle badges: roomy enough for a full three-digit line, with
     a category colour and a direction tip that reads as part of the badge. */
  .vehicle {
    position: relative;
    width: 58px; height: 58px;
    transition: opacity 200ms ease-out;
  }

  /* Rotate the complete badge, not only its tip: the reference markers behave
     like small physical tiles whose top edge points along the vehicle bearing. */
  .vehicle__bearing {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
  }
  /* A square standing on its corner, sitting far enough out that the badge
     covers its inner half. What is left is a spike growing out of the badge
     with the same outline continuing around it — one shape, not a badge with a
     triangle floating near it. */
  .vehicle__spike {
    position: absolute;
    top: 1px; left: 50%;
    margin-left: -8px;
    width: 16px; height: 16px;
    border-radius: 3px;
    background: var(--vehicle-color, #6D86A7);
    border: 2.5px solid var(--vehicle-edge, #668AB5);
    transform: rotate(45deg);
  }

  .vehicle__body {
    position: absolute;
    top: 9px; left: 9px; right: 9px; bottom: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10.5px;
    background-color: var(--vehicle-color, #6D86A7);
    background-image: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0) 52%);
    border: 2.5px solid var(--vehicle-edge, #668AB5);
    /* Contact shadow plus an ambient one: the marker sits on the map rather
       than hovering somewhere above it. */
    box-shadow: 0 1px 3px rgba(0,0,0,${dark ? '0.34' : '0.20'});
    z-index: 2;
    transition: transform 140ms ease-out;
  }

  .vehicle__label {
    color: #ffffff;
    font-size: 19px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.02em;
    /* Line numbers are read as a column of digits when markers stack up. */
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 1px rgba(0,0,0,0.10);
  }
  /* "715" and the letter lines still have to fit the same square. */
  .vehicle__label--long { font-size: 15px; letter-spacing: -0.05em; }

  .vehicle--selected { z-index: 1000 !important; }
  .vehicle--selected .vehicle__body {
    transform: scale(1.14);
    box-shadow: 0 2px 4px rgba(0,0,0,0.35), 0 10px 22px rgba(0,0,0,0.42);
  }
  .vehicle--selected .vehicle__body::after {
    content: '';
    position: absolute;
    top: -4px; left: -4px; right: -4px; bottom: -4px;
    border-radius: 12px;
    border: 2.5px solid var(--vehicle-edge, #536D8E);
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    0%   { transform: scale(0.86); opacity: 0.85; }
    100% { transform: scale(1.5); opacity: 0; }
  }

  /* With one vehicle chosen the rest step back, so the eye lands on it and its
     route. It is one class on the pane — not a single marker is rebuilt for it,
     which is the whole reason it can be done on every selection. */
  .leaflet-vehicles-pane.is-focused .vehicle:not(.vehicle--selected) { opacity: 0.4; }

  /* Markers glide between polls instead of jumping, but never during a zoom —
     Leaflet is already animating a transform there and the two fight. */
  .leaflet-marker-icon.vehicle-marker { transition: transform 900ms linear; }
  .leaflet-zoom-anim .leaflet-marker-icon.vehicle-marker { transition: none; }

  .stop-dot {
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--ring);
    border: 3px solid var(--line-color, #475569);
    box-shadow: 0 1px 3px rgba(0,0,0,0.45);
  }
  .stop-dot--plain {
    width: 10px; height: 10px;
    border-width: 2.5px;
    border-color: var(--chrome-fg);
  }

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
  var VEHICLE_COLOR = ${VEHICLE_PALETTE};
  var VEHICLE_BORDER_COLOR = ${VEHICLE_BORDER_PALETTE};
  var dark = ${dark ? 'true' : 'false'};

  /* Line and stop names come from upstream feeds, so nothing reaches the DOM
     as markup without going through here first. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function colorFor(type) { return LINE_COLOR[type] || LINE_COLOR.unknown; }
  function vehicleColorFor(type) { return VEHICLE_COLOR[type] || VEHICLE_COLOR.unknown; }
  function vehicleBorderColorFor(type) {
    return VEHICLE_BORDER_COLOR[type] || VEHICLE_BORDER_COLOR.unknown;
  }

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

  function iconHtml(vehicle, selected) {
    var color = vehicleColorFor(vehicle.type);
    var edge = vehicleBorderColorFor(vehicle.type);
    var chosen = selected ? ' vehicle--selected' : '';
    var label = String(vehicle.line == null ? '' : vehicle.line);
    var long = label.length > 3 ? ' vehicle__label--long' : '';
    var rotation = Number.isFinite(vehicle.heading)
      ? ' style="transform:rotate(' + vehicle.heading + 'deg)"'
      : '';
    var labelRotation = Number.isFinite(vehicle.heading)
      ? ' style="transform:rotate(' + (-vehicle.heading) + 'deg)"'
      : '';
    var spike = Number.isFinite(vehicle.heading) ? '<div class="vehicle__spike"></div>' : '';
    return '<div class="vehicle' + chosen + '" style="--vehicle-color:' + color
      + ';--vehicle-edge:' + edge + '">'
      + '<div class="vehicle__bearing"' + rotation + '>'
      + spike + '<div class="vehicle__body">'
      + '<span class="vehicle__label' + long + '"' + labelRotation + '>'
      + escapeHtml(label) + '</span>'
      + '</div></div></div>';
  }

  /**
   * What the marker looks like, reduced to a string.
   *
   * The heading is bucketed to 15° because otherwise a degree of GPS jitter
   * counts as a change and redraws every icon on the screen on every poll.
   */
  function keyFor(vehicle, selected) {
    var bucket = Number.isFinite(vehicle.heading) ? Math.round(vehicle.heading / 15) : -1;
    return vehicle.line + '|' + vehicle.type + '|' + bucket + '|' + (selected ? 1 : 0);
  }

  /** One place that knows the marker's geometry. */
  function vehicleIcon(vehicle, selected) {
    return L.divIcon({
      className: 'vehicle-marker',
      html: iconHtml(vehicle, selected),
      iconSize: [58, 58],
      iconAnchor: [29, 29],
    });
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
        marker.bindTooltip(tooltipFor(vehicle), { direction: 'top', offset: [0, -22] });
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
  }

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
  }

  /* --- route and stops ---------------------------------------------------- */

  function setRoute(shape) {
    routeLayer.clearLayers();
    stopLayer.clearLayers();
    if (!shape || !shape.points || !shape.points.length) return;

    var color = colorFor(shape.type);

    // A halo under the line, in the opposite tone to the map rather than the
    // same one. A dark casing on a dark map hid the darker half of the palette
    // completely — line 249 in #3730A3 was a row of stop dots and no route.
    L.polyline(shape.points, {
      color: dark ? '#ffffff' : '#000000',
      weight: 9,
      opacity: dark ? 0.32 : 0.22,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);

    L.polyline(shape.points, {
      color: color,
      weight: 5.5,
      opacity: 1,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(routeLayer);

    (shape.stops || []).forEach(function (stop) {
      if (!isFinite(stop.lat) || !isFinite(stop.lon)) return;
      var marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: '<div class="stop-dot" style="--line-color:' + color + '"></div>',
          iconSize: [11, 11],
          iconAnchor: [5.5, 5.5],
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
  }

  /** Nearby stops, shown when nothing else is selected. */
  function setStops(stops) {
    stopLayer.clearLayers();
    (stops || []).forEach(function (stop) {
      if (!isFinite(stop.lat) || !isFinite(stop.lon)) return;
      var marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: '<div class="stop-dot stop-dot--plain"></div>',
          iconSize: [9, 9],
          iconAnchor: [4.5, 4.5],
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
      case 'stops': setStops(message.stops || []); break;
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
  });

  send({ type: 'ready' });
})();
</script>
</body>
</html>`;
