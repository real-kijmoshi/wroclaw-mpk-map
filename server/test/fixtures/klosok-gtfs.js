'use strict';

const AdmZip = require('adm-zip');

/**
 * A GTFS archive shaped the way PT KŁOSOK's buses are matched against the
 * Wrocław feed: routes owned by agency 28 ("PT KŁOSOK"), and trips carrying
 * the `brigade_id` / `vehicle_id` columns the live GTFS-RT positions join on
 * when the feed omits trip ids.
 *
 * Timetable (Europe/Warsaw service days):
 *   - t911a  08:00–08:20  line 911, vehicle 1201, brigade 12
 *   - t911b  10:00–10:20  line 911, vehicle 1201, brigade 12  (same bus, later run)
 *   - t911c  09:00–09:20  line 911, vehicle 1202, brigade 13
 *   - t911d  09:10–09:30  line 911, vehicle 1202, brigade 13  (overlaps t911c —
 *            09:10–09:20 is genuinely ambiguous, which is the point)
 *   - t921a  12:00–12:30  line 921, vehicle 2101, brigade 21
 *   - t921n  25:00–25:30  line 921, vehicle 2101, brigade 21  (night run on the
 *            previous service day, the past-midnight case)
 */
const buildKlosokFixtureZip = () => {
  const files = {
    'agency.txt': [
      'agency_id,agency_name,agency_url,agency_timezone',
      '28,PT KŁOSOK,https://klosok.eu,Europe/Warsaw',
    ].join('\n'),

    'routes.txt': [
      'route_id,agency_id,route_short_name,route_long_name,route_type',
      '911,28,911,WIEPRZYCE - DWORZEC AUTOBUSOWY,3',
      '921,28,921,KAMIEŃ - DWORZEC AUTOBUSOWY,3',
    ].join('\n'),

    'trips.txt': [
      'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade_id,vehicle_id',
      '911,WEEKDAY,t911a,WIEPRZYCE,0,s911,12,1201',
      '911,WEEKDAY,t911b,WIEPRZYCE,0,s911,12,1201',
      '911,WEEKDAY,t911c,LEŚNICA,1,s911r,13,1202',
      '911,WEEKDAY,t911d,LEŚNICA,1,s911r,13,1202',
      '921,WEEKDAY,t921a,KAMIEŃ,0,s921,21,2101',
      '921,WEEKEND,t921n,NOCNY,0,s921n,21,2101',
    ].join('\n'),

    'stops.txt': [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon',
      '1,101,Rynek,51.11000,17.03200',
      '3,103,Oporów,51.08000,16.98000',
      '4,104,Biskupin,51.10000,17.10000',
      '5,105,Krzyki,51.07000,17.03000',
    ].join('\n'),

    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      't911a,08:00:00,08:00:00,1,1',
      't911a,08:20:00,08:20:00,3,2',
      't911b,10:00:00,10:00:00,1,1',
      't911b,10:20:00,10:20:00,3,2',
      't911c,09:00:00,09:00:00,3,1',
      't911c,09:20:00,09:20:00,4,2',
      't911d,09:10:00,09:10:00,3,1',
      't911d,09:30:00,09:30:00,4,2',
      't921a,12:00:00,12:00:00,1,1',
      't921a,12:30:00,12:30:00,5,2',
      't921n,25:00:00,25:00:00,1,1',
      't921n,25:30:00,25:30:00,5,2',
    ].join('\n'),

    'shapes.txt': [
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
      's911,51.11000,17.03200,1',
      's911,51.10500,17.03300,2',
      's911,51.09500,17.01000,3',
      's911,51.08000,16.98000,4',
      's911r,51.08000,16.98000,1',
      's911r,51.09000,17.05000,2',
      's911r,51.10000,17.10000,3',
      's921,51.11000,17.03200,1',
      's921,51.09000,17.03100,2',
      's921,51.07000,17.03000,3',
      's921n,51.11000,17.03200,1',
      's921n,51.07000,17.03000,2',
    ].join('\n'),

    'calendar.txt': [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'WEEKDAY,1,1,1,1,1,0,0,20200101,20401231',
      'WEEKEND,0,0,0,0,0,1,1,20200101,20401231',
    ].join('\n'),
  };

  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
};

module.exports = { buildKlosokFixtureZip };
