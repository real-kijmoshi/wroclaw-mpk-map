'use strict';

const AdmZip = require('adm-zip');

/**
 * Builds a tiny but structurally complete GTFS archive in memory so the store
 * can be tested without downloading 40 MB from the city portal.
 *
 * Two variants of tram line 4 (one per direction) plus bus line 128.
 *
 * @param {{ omit?: string[], prefix?: string, feedDates?: { start: string, end: string }, stops?: [string, string, string, string, string][], shapesText?: string }} options
 *   `omit` leaves tables out, for testing the completeness check against the
 *   short snapshots the city's archive contains. `prefix` nests every table in
 *   a directory, which is how some publishers ship the archive. `feedDates`
 *   writes feed_info.txt, which is how an archive states when it takes effect.
 *   `stops` replaces the stops table entirely with `[stop_id, stop_code,
 *   stop_name, stop_lat, stop_lon]` tuples, for search tests that need many
 *   stops or specific names. `shapesText` replaces shapes.txt, for cache tests
 *   that need a second timetable whose geometry differs from the default.
 */
const buildFixtureZip = ({
  omit = [],
  prefix = '',
  feedDates = null,
  stops = null,
  shapesText = null,
} = {}) => {
  const stopsTable = stops ?? [
    ['1', '101', 'Rynek', '51.11000', '17.03200'],
    ['2', '102', 'Świdnicka', '51.10500', '17.03300'],
    ['3', '103', 'Oporów', '51.08000', '16.98000'],
    ['4', '104', 'Biskupin', '51.10000', '17.10000'],
    ['5', '105', 'Krzyki', '51.07000', '17.03000'],
  ];

  const files = {
    'routes.txt': [
      'route_id,route_short_name,route_long_name,route_type,route_color',
      '4,4,BISKUPIN - OPORÓW,0,E30613',
      '128,128,LEŚNICA - KRZYKI,3,',
      '240,240,NIGHT,3,',
    ].join('\n'),

    // `wheelchair_accessible` is optional in GTFS and the three codes have to
    // survive the round trip: 1 accessible, 2 not, 0/blank no information.
    //
    // `vehicle_id` is one of this feed's extra columns and does double duty:
    // t4a/t4a2 point at `vehicle_types.txt` below, while t128's `8123` is a
    // physical vehicle id of the kind Kłosok's GTFS-RT joins on and resolves to
    // no type at all. Both shapes are here so the store is pinned on telling
    // them apart.
    'trips.txt': [
      'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,wheelchair_accessible,vehicle_id',
      '4,WEEKDAY,t4a,OPORÓW,0,s4a,1,VT1',
      '4,WEEKDAY,t4a2,OPORÓW,0,s4a,2,VT2',
      '4,WEEKDAY,t4b,BISKUPIN,1,s4b,0,',
      '128,WEEKDAY,t128,KRZYKI,0,s128,,8123',
      '240,WEEKEND,tn1,NOC,0,sn1,1,VT1',
    ].join('\n'),

    // Not a GTFS table. This feed describes its stock in prose rather than in
    // flag columns, which is the case `readVehicleTypes` has to cope with —
    // VT3 states its equipment in columns instead, so both readings are pinned.
    'vehicle_types.txt': [
      'vehicle_type_id,vehicle_type_name,vehicle_type_description',
      'VT1,Moderus Beta MF 24 AC,Tramwaj częściowo niskopodłogowy z klimatyzacją',
      'VT2,Konstal 105Na,Tramwaj wysokopodłogowy bez klimatyzacji',
      'VT3,Solaris Urbino 12,',
    ].join('\n'),

    'stops.txt': [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon',
      ...stopsTable.map((row) => row.join(',')),
    ].join('\n'),

    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      't4a,08:00:00,08:00:00,1,1',
      't4a,08:05:00,08:05:00,2,2',
      't4a,08:15:00,08:15:00,3,3',
      't4a2,09:00:00,09:00:00,1,1',
      't4a2,09:05:00,09:05:00,2,2',
      't4b,10:00:00,10:00:00,3,1',
      't4b,10:10:00,10:10:00,4,2',
      't128,12:00:00,12:00:00,1,1',
      't128,12:20:00,12:20:00,5,2',
      'tn1,25:30:00,25:30:00,1,1',
      'tn1,25:45:00,25:45:00,5,2',
    ].join('\n'),

    // s4a runs east->west through the centre, s4b is the return leg further north.
    // `shapesText` lets a caller swap in different geometry (same shape ids, so
    // variant selection is stable) — used by the shape cache tests to prove a
    // timetable refresh is not served the old shapes.
    'shapes.txt': shapesText
      ? shapesText
      : [
          'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
          's4a,51.11000,17.03200,1',
          's4a,51.10500,17.03300,2',
          's4a,51.09500,17.01000,3',
          's4a,51.08000,16.98000,4',
          's4b,51.08000,16.98000,1',
          's4b,51.09000,17.05000,2',
          's4b,51.10000,17.10000,3',
          's128,51.11000,17.03200,1',
          's128,51.09000,17.03100,2',
          's128,51.07000,17.03000,3',
          'sn1,51.11000,17.03200,1',
          'sn1,51.07000,17.03000,2',
        ].join('\n'),

    'calendar.txt': [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'WEEKDAY,1,1,1,1,1,0,0,20200101,20401231',
      'WEEKEND,0,0,0,0,0,1,1,20200101,20401231',
    ].join('\n'),

    'calendar_dates.txt': [
      'service_id,date,exception_type',
      'WEEKDAY,20261225,2',
      'WEEKEND,20261225,1',
    ].join('\n'),
  };

  if (feedDates) {
    files['feed_info.txt'] = [
      'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date',
      `MPK,https://mpk.wroc.pl,pl,${feedDates.start},${feedDates.end}`,
    ].join('\n');
  }

  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    if (omit.includes(name.replace('.txt', ''))) continue;
    zip.addFile(`${prefix}${name}`, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
};

module.exports = { buildFixtureZip };
