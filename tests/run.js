// Unit tests for the shell-independent modules in lib/.
// Run from the repository root:  gjs -m tests/run.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {normalize, rainSoon} from '../lib/openMeteo.js';
import {
    displayName, locationId, parseCoordinates,
    readFavorites, splitCountrySuffix, writeFavorites,
} from '../lib/location.js';
import {
    aqiStyle, alignedTicks, dominantCode, formatAmount, iconName, tempColor, temperatureTicks, uvStyle, valueTicks, windArrow,
} from '../lib/conditions.js';
import {mergeAirQuality, normalizeAirQuality} from '../lib/airQuality.js';
import {formatClock, formatHour, formatWeekday, resolveClockFormat} from '../lib/timeFormat.js';

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        print(`  ok    ${name}`);
    } catch (e) {
        failed++;
        print(`  FAIL  ${name}\n        ${e.message}`);
    }
}

function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what} expected ${b}, got ${a}`);
}

function assert(cond, what) {
    if (!cond)
        throw new Error(`assertion failed: ${what}`);
}

function fixture(name) {
    const [, bytes] = GLib.file_get_contents(`${ROOT}/tests/fixtures/${name}`);
    return JSON.parse(new TextDecoder().decode(bytes));
}

const LOC = {name: 'Test', admin1: '', country: 'JP', lat: 35.68, lon: 139.69};

print('openMeteo.normalize');

for (const name of ['tokyo-celsius.json', 'newyork-fahrenheit.json']) {
    const json = fixture(name);
    const model = normalize(json, {location: LOC, fetchedAt: 1});

    test(`${name}: nowIndex is the location-local current hour`, () => {
        eq(model.hours[model.nowIndex].time, `${json.current.time.slice(0, 13)}:00`);
    });
    test(`${name}: hours cover the whole forecast, earlier ones marked past`, () => {
        eq(model.hours.length, json.hourly.time.length);
        eq(model.hours.findIndex(h => !h.past), model.nowIndex);
        eq(model.hours[0].time.slice(11), '00:00');
    });
    test(`${name}: exactly one day is today, and it is the location's date`, () => {
        eq(model.days.filter(d => d.isToday).map(d => d.date), [json.current.time.slice(0, 10)]);
    });
    test(`${name}: every hour's date exists in days`, () => {
        const dates = new Set(model.days.map(d => d.date));
        assert(model.hours.every(h => dates.has(h.date)), 'hour dates ⊆ day dates');
    });
    test(`${name}: location details (elevation, timezone abbreviation)`, () => {
        eq(model.elevation, Math.round(json.elevation));
        eq(model.timezoneAbbr, json.timezone_abbreviation);
    });
    test(`${name}: current temperature comes from current block`, () => {
        eq(model.current.temp, Math.round(json.current.temperature_2m));
    });
}

test('units follow the response (°F / mph)', () => {
    const model = normalize(fixture('newyork-fahrenheit.json'), {location: LOC, fetchedAt: 1});
    eq(model.units, {temp: '°F', wind: 'mph', rain: 'in'});
});
test('units follow the response (°C / km/h)', () => {
    const model = normalize(fixture('tokyo-celsius.json'), {location: LOC, fetchedAt: 1});
    eq(model.units, {temp: '°C', wind: 'km/h', rain: 'mm'});
});
test('current time between slots falls back to the containing hour', () => {
    const json = fixture('tokyo-celsius.json');
    json.current.time = `${json.hourly.time[5].slice(0, 13)}:45`;
    const model = normalize(json, {location: LOC, fetchedAt: 1});
    eq(model.hours[model.nowIndex].time, json.hourly.time[5]);
});
test('current time missing from hourly falls back to last earlier slot', () => {
    const json = fixture('tokyo-celsius.json');
    json.current.time = `${json.hourly.time[7].slice(0, 13)}:30`;
    json.hourly.time[7] = `${json.hourly.time[7].slice(0, 11)}99:00`; // corrupt slot
    const model = normalize(json, {location: LOC, fetchedAt: 1});
    eq(model.hours[model.nowIndex].time, json.hourly.time[6]);
});
test('malformed response throws', () => {
    let threw = false;
    try {
        normalize({error: true, reason: 'x'}, {location: LOC, fetchedAt: 1});
    } catch {
        threw = true;
    }
    assert(threw, 'throws');
});
test('dominant daily code: mixed day reports two codes', () => {
    const json = fixture('tokyo-celsius.json');
    const date = json.daily.time[2];
    json.hourly.time.forEach((t, i) => {
        if (t.startsWith(date))
            json.hourly.weather_code[i] = parseInt(t.slice(11, 13)) < 16 ? 3 : 61;
    });
    const day = normalize(json, {location: LOC, fetchedAt: 1}).days[2];
    eq([day.code, day.code2], [3, 61]);
});

print('location');

test('parseCoordinates accepts common forms', () => {
    eq(parseCoordinates('50.08, 14.42'), {lat: 50.08, lon: 14.42});
    eq(parseCoordinates(' -33.9 18.4 '), {lat: -33.9, lon: 18.4});
    eq(parseCoordinates('+40;-74'), {lat: 40, lon: -74});
});
test('parseCoordinates rejects invalid input', () => {
    for (const s of ['91, 0', '0, 181', 'Prague', '11000', '50.08,', ''])
        eq(parseCoordinates(s), null, s);
});
test('splitCountrySuffix', () => {
    eq(splitCountrySuffix('11000, cz'), {query: '11000', country: 'CZ'});
    eq(splitCountrySuffix('New York'), {query: 'New York', country: ''});
    eq(splitCountrySuffix('Springfield, IL, US'), {query: 'Springfield, IL', country: 'US'});
});
test('displayName abbreviates US states', () => {
    eq(displayName({name: 'Denver', admin1: 'Colorado', country: 'US', lat: 0, lon: 0}), 'Denver, CO');
    eq(displayName({name: 'Prague', admin1: 'Prague', country: 'CZ', lat: 0, lon: 0}), 'Prague, CZ');
});
test('locationId is stable to 4 decimals', () => {
    eq(locationId({lat: 50.088041, lon: 14.4207601}), '50.0880,14.4208');
});

print('timeFormat');

test('formatHour 24h / 12h', () => {
    eq(formatHour('2026-09-29T14:00', '24h'), '14:00');
    eq(formatHour('2026-09-29T00:00', '24h'), '00:00');
    assert(/^2\s?\S*$/.test(formatHour('2026-09-29T14:00', '12h')), formatHour('2026-09-29T14:00', '12h'));
});
test('formatClock keeps minutes', () => {
    eq(formatClock('2026-09-29T06:42', '24h'), '06:42');
    assert(formatClock('2026-09-29T18:05', '12h').startsWith('6:05'), formatClock('2026-09-29T18:05', '12h'));
});
test('formatWeekday works on bare dates independent of system tz', () => {
    // 2026-09-29 is a Tuesday everywhere.
    eq(formatWeekday('2026-09-29', true), GLib.DateTime.new_utc(2026, 9, 29, 12, 0, 0).format('%A'));
});
test('resolveClockFormat', () => {
    const fake = v => ({get_string: () => v});
    eq(resolveClockFormat('12h', fake('24h')), '12h');
    eq(resolveClockFormat('system', fake('12h')), '12h');
    eq(resolveClockFormat('system', fake('24h')), '24h');
});

print('settings');

function freshSettings() {
    const dir = GLib.dir_make_tmp('weather-test-XXXXXX');
    const [ok, , err] = GLib.spawn_command_line_sync(
        `glib-compile-schemas --targetdir=${dir} ${ROOT}/schemas`);
    if (!ok || !GLib.file_test(`${dir}/gschemas.compiled`, GLib.FileTest.EXISTS))
        throw new Error(`schema compile failed: ${new TextDecoder().decode(err)}`);
    const source = Gio.SettingsSchemaSource.new_from_directory(dir, null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.crisps-weather', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

test('favorites round-trip', () => {
    const s = freshSettings();
    const favs = [{name: 'Prague', admin1: 'Prague', country: 'CZ', lat: 50.088, lon: 14.4208}];
    writeFavorites(s, favs);
    eq(readFavorites(s), favs);
});

print('conditions');

test('iconName uses night icons only where they exist', () => {
    eq(iconName(0, false), 'weather-clear-night-symbolic');
    eq(iconName(61, false), 'weather-showers-symbolic');
    eq(iconName(12345), 'weather-clear-symbolic');
});

test('tempColor gives the same band for equivalent °C and °F', () => {
    for (const [c, f] of [[-5, 23], [5, 41], [15, 59], [20, 68], [27, 81], [32, 90], [40, 104]])
        eq(tempColor(f, '°F'), tempColor(c, '°C'), `${c}°C / ${f}°F`);
    assert(tempColor(20, '°C', 'light') !== tempColor(20, '°C', 'dark'), 'light palette differs');
});

test('uvStyle levels', () => {
    eq([0, 3, 6, 8, 11].map(uv => uvStyle(uv).label), ['Low', 'Moderate', 'High', 'Very High', 'Extreme']);
});

test('dominantCode prefers the more frequent, then the more severe code', () => {
    eq(dominantCode([{code: 3}, {code: 61}, {code: 3}]), 3);
    eq(dominantCode([{code: 3}, {code: 61}]), 61);
    eq(dominantCode([]), 0);
});

test('temperatureTicks: round steps covering the data', () => {
    eq(temperatureTicks(10, 24), {lo: 10, hi: 25, ticks: [10, 15, 20, 25]});
    for (const [a, b] of [[20, 20], [18, 19], [-7, 4], [55, 98], [0, 1]]) {
        const {lo, hi, ticks} = temperatureTicks(a, b);
        assert(lo <= a && hi >= b, `${a}..${b} inside ${lo}..${hi}`);
        assert(ticks.length >= 3 && ticks.length <= 5, `${a}..${b}: ${ticks.length} ticks`);
    }
});

test('windArrow points downwind', () => {
    eq([0, 90, 180, 270, 359].map(windArrow), ['↓', '←', '↑', '→', '↓']);
});

test('aqiStyle bands', () => {
    eq([10, 30, 50, 70, 90, 150].map(a => aqiStyle(a).label),
        ['Good', 'Fair', 'Moderate', 'Poor', 'Very Poor', 'Extremely Poor']);
});

test('formatAmount', () => {
    eq([formatAmount(0, 'mm'), formatAmount(0.4, 'mm'), formatAmount(12.3, 'mm'), formatAmount(0.05, 'in')],
        ['0', '0.4', '12', '.05']);
});

test('valueTicks start at zero and cover the maximum', () => {
    eq(valueTicks(100), {lo: 0, hi: 100, ticks: [0, 50, 100]});
    eq(valueTicks(0, 1).hi >= 1, true);
    for (const m of [0.3, 2.7, 7, 36, 180]) {
        const {hi, ticks} = valueTicks(m);
        assert(hi >= m && ticks.length >= 2 && ticks.length <= 4, `${m}: ${ticks}`);
    }
});

test('alignedTicks use exactly the given number of intervals', () => {
    eq(alignedTicks(5, 3, 3), {lo: 0, hi: 6, ticks: [0, 2, 4, 6]});
    eq(alignedTicks(0, 1, 2), {lo: 0, hi: 1, ticks: [0, 0.5, 1]});
    eq(alignedTicks(9, 3, 3).hi >= 9, true);
});

print('rain soon / air quality');

const MIN = t => `2026-09-29T${t}`;
test('rainSoon: starting, stopping, none', () => {
    const times = ['14:30', '14:45', '15:00', '15:15', '15:30', '15:45', '16:00'].map(MIN);
    eq(rainSoon({time: times, precipitation: [0, 0, 0.3, 0.5, 0, 0, 0]}, MIN('14:30')), {state: 'starting', minutes: 30});
    eq(rainSoon({time: times, precipitation: [0.2, 0.4, 0, 0, 0, 0, 0]}, MIN('14:30')), {state: 'stopping', minutes: 30});
    eq(rainSoon({time: times, precipitation: [0, 0, 0, 0, 0, 0, 0]}, MIN('14:30')), null);
    eq(rainSoon(undefined, MIN('14:30')), null);
});

test('air quality merges by hour', () => {
    const air = normalizeAirQuality({
        current: {european_aqi: 33.4, birch_pollen: 0.2, grass_pollen: 12.6, ragweed_pollen: null},
        hourly: {time: [MIN('00:00'), MIN('01:00')], european_aqi: [31, 26]},
    });
    eq(air.aqi, 33);
    eq(air.pollen, [{name: 'Grass', value: 13}]);
    const model = {current: {}, hours: [{time: MIN('01:00')}, {time: MIN('02:00')}]};
    mergeAirQuality(model, air);
    eq(model.hours.map(h => h.aqi), [26, null]);
});

print(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    imports.system.exit(1);
