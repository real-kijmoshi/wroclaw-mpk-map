'use strict';

const AdmZip = require('adm-zip');

/**
 * A tiny but structurally faithful KD (Koleje Dolnośląskie) GTFS archive,
 * mirroring the real sample at kd.kiedyprzyjedzie.pl: rail routes (route_type 2)
 * named D6/D1, platform-level stops under parent stations, trips WITHOUT
 * shape_id and WITHOUT trip_short_name, and past-midnight stop times.
 *
 * Trips deliberately carry no shape_id — exactly like the real feed — so the
 * store is proven to survive geometry-less input rather than assuming it.
 *
 * @param {{ omit?: string[], prefix?: string }} options
 */
const buildKdFixtureZip = ({ omit = [], prefix = '' } = {}) => {
  const files = {
    'agency.txt': [
      'agency_id,agency_name,agency_url,agency_timezone',
      '279,Koleje Dolnośląskie,https://kolejedolnoslaskie.pl,Europe/Warsaw',
    ].join('\n'),

    'routes.txt': [
      'route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
      '356696,279,D6,,2,F6C32F',
      '356671,279,D1,,2,',
      '356672,279,D1/D62,,2,',
    ].join('\n'),

    'trips.txt': [
      'route_id,service_id,trip_id,trip_headsign,direction_id,block_id',
      '356696,1_445405,t1,Wrocław Główny,,25400/60461',
      '356696,1_445406,t2,Wrocław Główny,,25401/60462',
      '356671,1_445407,t3,Sędzisław,,25402/60463',
      '356672,1_445408,t4,Jelenia Góra,,25403/60464',
    ].join('\n'),

    // Station 1 (Wrocław Główny) has platforms 10/11; station 2 (Wałbrzych
    // Główny) has platforms 20/21. Stop times reference the platforms.
    'stops.txt': [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code',
      '1,75,Wrocław Główny,51.09899,17.03680,1,,',
      '10,,Wrocław Główny,51.09899,17.03680,0,1,VI',
      '11,,Wrocław Główny,51.09899,17.03680,0,1,V',
      '2,80,Wałbrzych Główny,50.77200,16.28700,1,,',
      '20,,Wałbrzych Główny,50.77200,16.28700,0,2,I',
      '21,,Wałbrzych Główny,50.77200,16.28700,0,2,II',
    ].join('\n'),

    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type',
      't1,08:00:00,08:00:00,10,0,,0',
      't1,08:15:00,08:15:00,21,1,,0',
      't1,08:30:00,08:30:00,2,2,,0',
      't2,09:00:00,09:00:00,11,0,,0',
      't2,09:20:00,09:20:00,20,1,,0',
      't3,10:00:00,10:00:00,10,0,,0',
      't3,10:25:00,10:25:00,20,1,,0',
      't3,25:30:00,25:30:00,2,2,,0',
      't4,12:00:00,12:00:00,11,0,,0',
      't4,12:40:00,12:40:00,20,1,,0',
    ].join('\n'),

    // The real feed lists every service as its own row in calendar.txt.
    'calendar.txt': [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      '1_445405,1,1,1,1,1,0,0,20260101,20261231',
      '1_445406,1,1,1,1,1,0,0,20260101,20261231',
      '1_445407,0,0,0,0,0,1,1,20260101,20261231',
      '1_445408,1,1,1,1,1,1,1,20260101,20261231',
    ].join('\n'),

    'calendar_dates.txt': [
      'service_id,date,exception_type',
      '1_445405,20261225,2',
      '1_445408,20261225,1',
    ].join('\n'),
  };

  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    if (omit.includes(name.replace('.txt', ''))) continue;
    zip.addFile(`${prefix}${name}`, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
};

module.exports = { buildKdFixtureZip };
