/*
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Open-Meteo air-quality client (CAMS data): European AQI worldwide, pollen
// in Europe only (null elsewhere). Fetched only when enabled, and merged into
// the forecast model by the WeatherManager.

import {getJson} from './http.js';

const AIR_QUALITY_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const POLLEN = [
    ['alder_pollen', 'Alder'],
    ['birch_pollen', 'Birch'],
    ['grass_pollen', 'Grass'],
    ['mugwort_pollen', 'Mugwort'],
    ['olive_pollen', 'Olive'],
    ['ragweed_pollen', 'Ragweed'],
];

// Grains/m³ below which a pollen type isn't worth mentioning.
const POLLEN_NOTABLE = 10;

export async function fetchAirQuality(session, location, cancellable = null) {
    const json = await getJson(session, AIR_QUALITY_API, {
        latitude: location.lat,
        longitude: location.lon,
        current: ['european_aqi', ...POLLEN.map(([key]) => key)].join(','),
        hourly: 'european_aqi',
        timezone: 'auto',
        forecast_days: 7,
    }, cancellable);
    return normalizeAirQuality(json);
}

/** @returns {{aqi: number|null, pollen: {name, value}[], hourly: Map<string, number>}} */
export function normalizeAirQuality(json) {
    const current = json?.current ?? {};
    const hourly = new Map();
    const times = json?.hourly?.time ?? [];
    const values = json?.hourly?.european_aqi ?? [];
    times.forEach((t, i) => {
        if (typeof values[i] === 'number')
            hourly.set(t, Math.round(values[i]));
    });
    const pollen = POLLEN
        .map(([key, name]) => ({name, value: current[key]}))
        .filter(p => typeof p.value === 'number' && p.value >= POLLEN_NOTABLE)
        .map(p => ({name: p.name, value: Math.round(p.value)}))
        .sort((a, b) => b.value - a.value);
    return {
        aqi: typeof current.european_aqi === 'number' ? Math.round(current.european_aqi) : null,
        pollen,
        hourly,
    };
}

/** Copy air quality into a forecast model (in place). */
export function mergeAirQuality(model, air) {
    model.current.aqi = air.aqi;
    model.current.pollen = air.pollen;
    for (const h of model.hours)
        h.aqi = air.hourly.get(h.time) ?? null;
    return model;
}
