/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Location resolution, search and favourites storage. Shared by the extension
// and the preferences window, so it must not import resource:///org/gnome/shell.
//
// A location is a plain object: {name, admin1, country, lat, lon}
// (country = ISO 3166-1 alpha-2, upper case; admin1 = state/region).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getJson} from './http.js';

const IP_API = 'https://ipinfo.io/json';
const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';

// GNOME Shell's own desktop id; allowed as a system app in geoclue.conf.
const GEOCLUE_DESKTOP_ID = 'org.gnome.Shell';
const GEOCLUE_TIMEOUT_MS = 10_000;
// Offline nearest-city names are used only when the city is this close.
const NEAREST_CITY_MAX_KM = 30;

const STATE_ABBR = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY',
    'district of columbia': 'DC',
};

export function makeLocation({name = '', admin1 = '', country = '', lat, lon}) {
    return {
        name: String(name),
        admin1: String(admin1 ?? ''),
        country: String(country ?? '').toUpperCase(),
        lat: Number(lat),
        lon: Number(lon),
    };
}

export function formatCoordinates(lat, lon) {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// Stable id used by the `active-location` setting.
export function locationId(loc) {
    return `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
}

// "Denver, CO" in the US, "Prague, CZ" elsewhere.
export function displayName(loc) {
    if (!loc)
        return '';
    const name = loc.name || formatCoordinates(loc.lat, loc.lon);
    if (loc.country === 'US' && loc.admin1)
        return `${name}, ${STATE_ABBR[loc.admin1.toLowerCase()] ?? loc.admin1}`;
    return loc.country ? `${name}, ${loc.country}` : name;
}

/**
 * Parse "50.08, 14.42" / "50.08 14.42" / "-33.9;18.4".
 * Returns {lat, lon} or null when the text is not a valid coordinate pair.
 */
export function parseCoordinates(text) {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:[,;]\s*|\s+)([+-]?\d+(?:\.\d+)?)\s*$/.exec(text ?? '');
    if (!m)
        return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180))
        return null;
    return {lat, lon};
}

// "11000, CZ" → {query: '11000', country: 'CZ'}.
export function splitCountrySuffix(text) {
    const m = /^(.*\S)\s*,\s*([A-Za-z]{2})\s*$/.exec(text ?? '');
    if (!m)
        return {query: (text ?? '').trim(), country: ''};
    return {query: m[1].trim(), country: m[2].toUpperCase()};
}

// ---- Favourites (GSettings `favorites`, type a(sssdd)) ----

export function readFavorites(settings) {
    return settings.get_value('favorites').deepUnpack()
        .map(([name, admin1, country, lat, lon]) => makeLocation({name, admin1, country, lat, lon}));
}

export function writeFavorites(settings, favorites) {
    settings.set_value('favorites', new GLib.Variant('a(sssdd)',
        favorites.map(f => [f.name, f.admin1, f.country, f.lat, f.lon])));
}

// ---- Auto-location cache (GSettings `auto-location-cache`, JSON) ----

export function readAutoCache(settings) {
    try {
        const cache = JSON.parse(settings.get_string('auto-location-cache') || 'null');
        if (cache?.location && Number.isFinite(cache.location.lat) && Number.isFinite(cache.location.lon))
            return {...cache, location: makeLocation(cache.location)};
    } catch {
        // Corrupt value: treat as empty.
    }
    return null;
}

export function writeAutoCache(settings, location, source) {
    settings.set_string('auto-location-cache', JSON.stringify({
        location,
        source,
        timestamp: Math.floor(GLib.get_real_time() / 1_000_000),
    }));
}

// ---- Resolution ----

let _world = undefined;

async function gweatherWorld() {
    if (_world === undefined) {
        try {
            const {default: GWeather} = await import('gi://GWeather?version=4.0');
            _world = {GWeather, world: GWeather.Location.get_world()};
        } catch (e) {
            console.debug(`Crisps Weather: GWeather unavailable: ${e.message}`);
            _world = null;
        }
    }
    return _world;
}

/**
 * Name a coordinate pair using GWeather's offline city database.
 * No network access. Falls back to the coordinates themselves.
 */
export async function locationForCoordinates(lat, lon) {
    const fallback = makeLocation({name: formatCoordinates(lat, lon), lat, lon});
    const gw = await gweatherWorld();
    const city = gw?.world?.find_nearest_city(lat, lon);
    if (!city)
        return fallback;

    const here = gw.GWeather.Location.new_detached('', null, lat, lon);
    const distanceKm = city.get_distance(here);
    let admin1 = '';
    for (let p = city.get_parent(); p; p = p.get_parent()) {
        if (p.get_level() === gw.GWeather.LocationLevel.ADM1) {
            admin1 = p.get_name();
            break;
        }
    }
    if (distanceKm > NEAREST_CITY_MAX_KM)
        return {...fallback, admin1: `near ${city.get_name()}`, country: city.get_country() ?? ''};
    return makeLocation({name: city.get_name(), admin1, country: city.get_country() ?? '', lat, lon});
}

export async function ipLookup(session, cancellable = null) {
    const json = await getJson(session, IP_API, {}, cancellable);
    const coords = parseCoordinates(json?.loc ?? '');
    if (!coords)
        throw new Error('IP geolocation returned no coordinates');
    return makeLocation({name: json.city, admin1: json.region, country: json.country, ...coords});
}

export function locationServicesEnabled() {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source?.lookup('org.gnome.system.location', true))
        return false;
    return new Gio.Settings({schema_id: 'org.gnome.system.location'}).get_boolean('enabled');
}

function cancelledError() {
    return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
}

// Stop the GeoClue client so it doesn't keep tracking position.
function stopGeoclue(simple) {
    try {
        simple?.get_client()?.call_stop(null, null);
    } catch {
        // Already gone.
    }
}

/**
 * Ask GeoClue for the current position (city accuracy), with a timeout.
 * Returns null if GeoClue is unavailable, denied or too slow.
 * Throws a CANCELLED GLib.Error when `cancellable` is cancelled.
 *
 * Geoclue.Simple.new() does not honour its GCancellable (it can wait on the
 * agent indefinitely), so the timeout and cancellation settle the promise
 * themselves; a late answer is stopped and discarded.
 */
export async function geoclueLookup(cancellable = null) {
    let Geoclue;
    try {
        ({default: Geoclue} = await import('gi://Geoclue?version=2.0'));
    } catch {
        return null;
    }
    if (cancellable?.is_cancelled())
        throw cancelledError();

    const simple = await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = 0;
        let cancelId = 0;
        const settle = () => {
            settled = true;
            if (timeoutId)
                GLib.Source.remove(timeoutId);
            timeoutId = 0;
            if (cancelId)
                cancellable.disconnect(cancelId);
            cancelId = 0;
        };

        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GEOCLUE_TIMEOUT_MS, () => {
            timeoutId = 0;
            settle();
            console.debug('Crisps Weather: GeoClue timed out');
            resolve(null);
            return GLib.SOURCE_REMOVE;
        });
        // connect_after: plain GObject signal. Gio.Cancellable.connect() is
        // g_cancellable_connect(), whose handler must not disconnect itself.
        cancelId = cancellable?.connect_after('cancelled', () => {
            cancelId = 0;
            settle();
            reject(cancelledError());
        }) ?? 0;

        Geoclue.Simple.new(GEOCLUE_DESKTOP_ID, Geoclue.AccuracyLevel.CITY, null, (_o, res) => {
            let result = null;
            try {
                result = Geoclue.Simple.new_finish(res);
            } catch (e) {
                console.debug(`Crisps Weather: GeoClue unavailable: ${e.message}`);
            }
            if (settled) {
                stopGeoclue(result);
                return;
            }
            settle();
            resolve(result);
        });
    });
    if (!simple)
        return null;

    try {
        const loc = simple.get_location();
        return loc ? await locationForCoordinates(loc.latitude, loc.longitude) : null;
    } finally {
        stopGeoclue(simple);
    }
}

// ---- Search (used from the preferences window only) ----

function fromOpenMeteo(r) {
    return makeLocation({
        name: r.name, admin1: r.admin1 ?? '', country: r.country_code ?? '',
        lat: r.latitude, lon: r.longitude,
    });
}

function fromNominatim(r) {
    const a = r.address ?? {};
    const name = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ??
        r.name ?? (r.display_name ?? '').split(',')[0];
    return makeLocation({
        name, admin1: a.state ?? '', country: a.country_code ?? '',
        lat: parseFloat(r.lat), lon: parseFloat(r.lon),
    });
}

function dedupe(list) {
    const seen = new Set();
    return list.filter(l => {
        if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon))
            return false;
        const id = locationId(l);
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
}

/**
 * Search for locations matching `text`:
 *   "50.08, 14.42"  → coordinates, named offline via GWeather
 *   "Prague"        → Open-Meteo geocoding, Nominatim free-text fallback
 *   "11000, CZ"     → postal code (optionally with ISO country), Nominatim fallback
 * Returns a list of locations (possibly empty).
 */
export async function searchLocations(session, text, cancellable = null) {
    const coords = parseCoordinates(text);
    if (coords)
        return [await locationForCoordinates(coords.lat, coords.lon)];

    const {query, country} = splitCountrySuffix(text);
    if (query.length < 2)
        return [];

    let results = [];
    try {
        const om = await getJson(session, GEOCODE_API, {
            name: query, count: 10, language: 'en', format: 'json', countryCode: country,
        }, cancellable);
        results = (om?.results ?? []).map(fromOpenMeteo);
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        // An invalid countryCode (e.g. "Paris, TX") yields HTTP 400: fall through.
        console.debug(`Crisps Weather: Open-Meteo geocoding failed: ${e.message}`);
    }
    if (results.length > 0)
        return dedupe(results);

    const isPostal = /\d/.test(query);
    const nm = await getJson(session, NOMINATIM_API, isPostal
        ? {postalcode: query, country, format: 'jsonv2', addressdetails: 1, limit: 5}
        : {q: country ? `${query}, ${country}` : query, format: 'jsonv2', addressdetails: 1, limit: 5},
    cancellable);
    return dedupe((Array.isArray(nm) ? nm : []).map(fromNominatim));
}
