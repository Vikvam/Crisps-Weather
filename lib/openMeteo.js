/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Open-Meteo forecast client. `normalize()` is pure so it can be unit-tested
// against saved API responses (tests/fixtures).
//
// `hours` covers the whole forecast from 00:00 today; hours before the current
// one are flagged `past` and `nowIndex` points at the current hour.
//
// All times in the model are the location's local wall-clock strings exactly
// as Open-Meteo returns them with timezone=auto ("2026-09-29T14:00"). They are
// never converted through the system timezone, so a favourite on the other
// side of the world still shows the right "Now" row and "Today".

import GLib from 'gi://GLib';

import {getJson} from './http.js';

const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';

const CURRENT = 'temperature_2m,weather_code,is_day,apparent_temperature';
const HOURLY = 'temperature_2m,weather_code,is_day,uv_index,precipitation_probability,precipitation,' +
    'apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,' +
    'sunrise,sunset,wind_speed_10m_max,wind_direction_10m_dominant';
// 15-minute precipitation for the next 3 hours, for "rain in ~30 min".
const MINUTELY_15 = 'precipitation';
const MINUTELY_STEPS = 12;
const SOON_STEPS = 8; // look 2 hours ahead
const WET_MM = 0.1;   // per 15 minutes

export async function fetchForecast(session, location, {fahrenheit = false} = {}, cancellable = null) {
    const json = await getJson(session, FORECAST_API, {
        latitude: location.lat,
        longitude: location.lon,
        current: CURRENT,
        hourly: HOURLY,
        daily: DAILY,
        minutely_15: MINUTELY_15,
        forecast_minutely_15: MINUTELY_STEPS,
        timezone: 'auto',
        forecast_days: 7,
        temperature_unit: fahrenheit ? 'fahrenheit' : undefined,
        wind_speed_unit: fahrenheit ? 'mph' : undefined,
        precipitation_unit: fahrenheit ? 'inch' : undefined,
    }, cancellable);
    return normalize(json, {
        location,
        fetchedAt: Math.floor(GLib.get_real_time() / 1_000_000),
    });
}

const round = v => (typeof v === 'number' ? Math.round(v) : null);
// Precipitation keeps one decimal (mm) or two (inches).
const amount = (v, inches) => (typeof v === 'number' ? Math.round(v * (inches ? 100 : 10)) / (inches ? 100 : 10) : 0);

/**
 * Whether rain starts or stops within the next two hours, from 15-minute data.
 * @returns {{state: 'starting'|'stopping'|'continuing', minutes: number}|null}
 */
export function rainSoon(minutely, nowTime, inches = false) {
    const times = minutely?.time;
    const values = minutely?.precipitation;
    if (!Array.isArray(times) || !Array.isArray(values))
        return null;
    let i = times.indexOf(nowTime);
    if (i < 0)
        i = times.findIndex(t => t > nowTime) - 1;
    if (i < 0)
        return null;
    const threshold = inches ? WET_MM / 25.4 : WET_MM;
    const wet = k => (values[k] ?? 0) >= threshold;
    const end = Math.min(values.length, i + SOON_STEPS + 1);
    const raining = wet(i);
    for (let k = i + 1; k < end; k++) {
        if (wet(k) !== raining)
            return {state: raining ? 'stopping' : 'starting', minutes: (k - i) * 15};
    }
    return raining ? {state: 'continuing', minutes: (end - 1 - i) * 15} : null;
}

// Index of the hourly slot containing `nowTime` (location-local).
function currentHourIndex(times, nowTime) {
    const idx = times.indexOf(`${nowTime.slice(0, 13)}:00`);
    if (idx >= 0)
        return idx;
    // Fallback: last slot that is not after now (string compare works for ISO).
    let last = 0;
    for (let i = 0; i < times.length && times[i] <= nowTime; i++)
        last = i;
    return last;
}

// Daily icons use the most common hourly weather code between 06:00 and 24:00
// rather than Open-Meteo's "most severe" daily code, so two hours of drizzle
// don't turn the whole day into a rain icon. A second code is reported when it
// covers at least 40% as many hours as the first.
function dominantCodes(codes) {
    if (!codes || codes.length === 0)
        return {primary: 0, secondary: null};
    const freq = {};
    for (const c of codes)
        freq[c] = (freq[c] || 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const primary = parseInt(sorted[0][0]);
    const secondary = sorted.length > 1 && sorted[1][1] >= sorted[0][1] * 0.4
        ? parseInt(sorted[1][0]) : null;
    return {primary, secondary};
}

export function normalize(json, {location, fetchedAt}) {
    const current = json?.current;
    const hourly = json?.hourly;
    const daily = json?.daily;
    if (!current?.time || !Array.isArray(hourly?.time) || !Array.isArray(daily?.time))
        throw new Error('Malformed forecast response');

    const nowTime = current.time;
    const today = nowTime.slice(0, 10);
    const tempUnit = json.hourly_units?.temperature_2m === '°F' ? '°F' : '°C';
    const windUnit = (json.hourly_units?.wind_speed_10m ?? '').includes('mp') ? 'mph' : 'km/h';
    const inches = (json.hourly_units?.precipitation ?? '').startsWith('inch');

    const nowSlot = currentHourIndex(hourly.time, nowTime);
    const hours = [];
    let nowIndex = 0;
    for (let i = 0; i < hourly.time.length; i++) {
        const temp = round(hourly.temperature_2m?.[i]);
        if (temp === null)
            continue;
        const time = hourly.time[i];
        if (i <= nowSlot)
            nowIndex = hours.length;
        hours.push({
            time,
            date: time.slice(0, 10),
            hour: parseInt(time.slice(11, 13)),
            past: i < nowSlot,
            temp,
            code: hourly.weather_code?.[i] ?? 0,
            isDay: hourly.is_day?.[i] === 1,
            uv: round(hourly.uv_index?.[i]) ?? 0,
            precip: hourly.precipitation_probability?.[i] ?? 0,
            rain: amount(hourly.precipitation?.[i], inches),
            feels: round(hourly.apparent_temperature?.[i]) ?? temp,
            humidity: round(hourly.relative_humidity_2m?.[i]) ?? 0,
            wind: round(hourly.wind_speed_10m?.[i]) ?? 0,
            gust: round(hourly.wind_gusts_10m?.[i]) ?? 0,
            windDir: round(hourly.wind_direction_10m?.[i]) ?? 0,
            aqi: null, // filled in from the air-quality API when enabled
        });
    }

    const codesByDate = {};
    for (let i = 0; i < hourly.time.length; i++) {
        const time = hourly.time[i];
        const hour = parseInt(time.slice(11, 13));
        if (hour < 6 || hourly.weather_code?.[i] === undefined)
            continue;
        const date = time.slice(0, 10);
        (codesByDate[date] ??= []).push(hourly.weather_code[i]);
    }

    const days = [];
    for (let d = 0; d < daily.time.length; d++) {
        const date = daily.time[d];
        const high = round(daily.temperature_2m_max?.[d]);
        const low = round(daily.temperature_2m_min?.[d]);
        if (high === null || low === null)
            continue;
        const {primary, secondary} = dominantCodes(codesByDate[date]);
        days.push({
            date,
            isToday: date === today,
            high,
            low,
            code: primary,
            code2: secondary,
            precip: daily.precipitation_probability_max?.[d] ?? 0,
            rain: amount(daily.precipitation_sum?.[d], inches),
            sunrise: daily.sunrise?.[d] ?? '',
            sunset: daily.sunset?.[d] ?? '',
            windMax: round(daily.wind_speed_10m_max?.[d]) ?? 0,
            windDir: round(daily.wind_direction_10m_dominant?.[d]) ?? 0,
        });
    }

    return {
        location,
        timezone: json.timezone ?? 'UTC',
        timezoneAbbr: json.timezone_abbreviation ?? '',
        elevation: typeof json.elevation === 'number' ? Math.round(json.elevation) : null,
        utcOffset: json.utc_offset_seconds ?? 0,
        fetchedAt,
        nowTime,
        nowIndex,
        today,
        units: {temp: tempUnit, wind: windUnit, rain: inches ? 'in' : 'mm'},
        current: {
            temp: round(current.temperature_2m) ?? hours[nowIndex]?.temp ?? 0,
            code: current.weather_code ?? hours[nowIndex]?.code ?? 0,
            isDay: current.is_day === 1,
            feels: round(current.apparent_temperature),
            aqi: null,
            pollen: [],
        },
        rainSoon: rainSoon(json.minutely_15, nowTime, inches),
        hours,
        days,
    };
}
