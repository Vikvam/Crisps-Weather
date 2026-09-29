/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Presentation helpers for weather data: WMO codes → icons and labels, and
// the colour scales for temperature and UV. Pure, so they can be unit-tested.

// WMO weather codes → GNOME symbolic icon names.
// Full code table: https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
const DAY_ICON_MAP = {
    0: 'weather-clear-symbolic',
    1: 'weather-few-clouds-symbolic',
    2: 'weather-few-clouds-symbolic',
    3: 'weather-overcast-symbolic',
    45: 'weather-fog-symbolic',
    48: 'weather-fog-symbolic',
    51: 'weather-showers-scattered-symbolic',
    53: 'weather-showers-scattered-symbolic',
    55: 'weather-showers-scattered-symbolic',
    56: 'weather-snow-symbolic',
    57: 'weather-snow-symbolic',
    61: 'weather-showers-symbolic',
    63: 'weather-showers-symbolic',
    65: 'weather-showers-symbolic',
    66: 'weather-freezing-rain-symbolic',
    67: 'weather-freezing-rain-symbolic',
    71: 'weather-snow-symbolic',
    73: 'weather-snow-symbolic',
    75: 'weather-snow-symbolic',
    77: 'weather-snow-symbolic',
    80: 'weather-showers-scattered-symbolic',
    81: 'weather-showers-symbolic',
    82: 'weather-showers-symbolic',
    85: 'weather-snow-symbolic',
    86: 'weather-snow-symbolic',
    95: 'weather-storm-symbolic',
    96: 'weather-storm-symbolic',
    99: 'weather-storm-symbolic',
};

// Night icons only exist for clear/few-clouds. All other codes fall through to DAY_ICON_MAP.
const NIGHT_ICON_MAP = {
    0: 'weather-clear-night-symbolic',
    1: 'weather-few-clouds-night-symbolic',
    2: 'weather-few-clouds-night-symbolic',
};

const WEATHER_SHORT = {
    0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime Fog',
    51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
    56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
    61: 'Rain', 63: 'Rain', 65: 'Heavy Rain',
    66: 'Freezing Rain', 67: 'Freezing Rain',
    71: 'Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
    80: 'Showers', 81: 'Showers', 82: 'Heavy Showers',
    85: 'Snow Showers', 86: 'Snow Showers',
    95: 'Storm', 96: 'Hail Storm', 99: 'Hail Storm',
};

const WIND_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function iconName(code, isDay = true) {
    if (!isDay && NIGHT_ICON_MAP[code] !== undefined)
        return NIGHT_ICON_MAP[code];
    return DAY_ICON_MAP[code] || 'weather-clear-symbolic';
}

export function weatherDesc(code) {
    return WEATHER_SHORT[code] || 'Unknown';
}

export function windDir(deg) {
    return WIND_DIRS[Math.round(deg / 22.5) % 16];
}

export function windLabel(speed, unit) {
    const kmh = unit === 'mph' ? speed * 1.609 : speed;
    if (kmh < 5) return 'Calm';
    if (kmh < 20) return 'Light';
    if (kmh < 40) return 'Breezy';
    if (kmh < 60) return 'Windy';
    if (kmh < 80) return 'Strong';
    return 'Gusty';
}

// Temperature scale in °C; °F values are converted before lookup.
const TEMP_STEPS = [0, 10, 18, 24, 30, 35];
// Bright shades read well on the dark shell theme, deeper ones on the light one.
const TEMP_COLORS = {
    dark: ['#64b5f6', '#42a5f5', '#26a69a', '#66bb6a', '#ffca28', '#ffa726', '#ef5350'],
    light: ['#1e88e5', '#1565c0', '#00897b', '#43a047', '#f9a825', '#ef6c00', '#d32f2f'],
};

export function tempColor(t, unit, variant = 'dark') {
    const c = unit === '°F' ? (t - 32) * 5 / 9 : t;
    let i = 0;
    while (i < TEMP_STEPS.length && c >= TEMP_STEPS[i])
        i++;
    return (TEMP_COLORS[variant] ?? TEMP_COLORS.dark)[i];
}

const UV_LEVELS = [
    {max: 2, label: 'Low', dark: '#8bc34a', light: '#558b2f'},
    {max: 5, label: 'Moderate', dark: '#ffc107', light: '#f9a825'},
    {max: 7, label: 'High', dark: '#ff9800', light: '#ef6c00'},
    {max: 10, label: 'Very High', dark: '#f44336', light: '#d32f2f'},
    {max: Infinity, label: 'Extreme', dark: '#ce93d8', light: '#8e24aa'},
];

export function uvStyle(uv, variant = 'dark') {
    const level = UV_LEVELS.find(l => uv <= l.max);
    return {color: variant === 'light' ? level.light : level.dark, label: level.label};
}

export const PRECIP_COLORS = {dark: '#64b5f6', light: '#1e88e5'};

/** Most frequent code among `hours` (ties: the more severe, i.e. higher, code). */
export function dominantCode(hours) {
    const freq = {};
    for (const h of hours)
        freq[h.code] = (freq[h.code] || 0) + 1;
    const [best] = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    return best ? parseInt(best[0]) : 0;
}

// Axis ticks: a round step giving 2–4 intervals, and the domain it spans.
export function temperatureTicks(tMin, tMax) {
    const step = [1, 2, 5, 10, 20, 50].find(c => c * 4 >= tMax - tMin) ?? 100;
    let lo = Math.floor(tMin / step) * step;
    let hi = Math.ceil(tMax / step) * step;
    if (hi - lo < 2 * step) {
        lo -= step;
        hi = lo + 3 * step;
        if (hi - step < tMax)
            hi += step;
    }
    const ticks = [];
    for (let t = lo; t <= hi; t += step)
        ticks.push(t);
    return {lo, hi, ticks};
}

// Arrow pointing where the wind blows *to* (wind from the north → ↓).
const WIND_ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];

export function windArrow(deg) {
    return WIND_ARROWS[Math.round(deg / 45) % 8];
}

// European AQI bands.
const AQI_LEVELS = [
    {max: 20, label: 'Good', dark: '#50f0e6', light: '#0f9b92'},
    {max: 40, label: 'Fair', dark: '#50ccaa', light: '#2e8b6f'},
    {max: 60, label: 'Moderate', dark: '#f0e641', light: '#a89a00'},
    {max: 80, label: 'Poor', dark: '#ff5050', light: '#d32f2f'},
    {max: 100, label: 'Very Poor', dark: '#e0587a', light: '#a01238'},
    {max: Infinity, label: 'Extremely Poor', dark: '#b07dd6', light: '#6a1b9a'},
];

export function aqiStyle(aqi, variant = 'dark') {
    const level = AQI_LEVELS.find(l => aqi <= l.max);
    return {color: variant === 'light' ? level.light : level.dark, label: level.label};
}

/** Rain amount with sensible precision: "0.4", "12", "0.05". */
export function formatAmount(value, unit) {
    if (!value)
        return '0';
    if (unit === 'in')
        return value < 1 ? value.toFixed(2).replace(/^0/, '') : value.toFixed(1);
    return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** Axis ticks from 0 for non-negative data: a round step, 1–`intervals` intervals. */
export function valueTicks(max, minTop = 1, intervals = 2) {
    const top = Math.max(max, minTop);
    const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500];
    const step = steps.find(c => c * intervals >= top) ?? 1000;
    const hi = Math.ceil(top / step - 1e-9) * step;
    const ticks = [];
    for (let k = 0; k * step <= hi + 1e-9; k++)
        ticks.push(Math.round(k * step * 100) / 100);
    return {lo: 0, hi, ticks};
}

/**
 * Ticks for a secondary (right) axis that must share the primary axis's grid
 * lines: exactly `intervals` round steps from 0, covering `max`.
 */
export function alignedTicks(max, minTop, intervals) {
    const top = Math.max(max, minTop);
    const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500];
    const step = steps.find(c => c * intervals >= top) ?? Math.ceil(top / intervals);
    const ticks = [];
    for (let k = 0; k <= intervals; k++)
        ticks.push(Math.round(k * step * 100) / 100);
    return {lo: 0, hi: step * intervals, ticks};
}

/** "#rrggbb" → [r, g, b] in 0..1, for Cairo. */
export function hexToRgb(hex) {
    return [0, 1, 2].map(n => parseInt(hex.slice(1 + n * 2, 3 + n * 2), 16) / 255);
}
