/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// The details card shown next to the popup while hovering a day.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {
    PRECIP_COLORS, dominantCode, iconName, uvStyle, weatherDesc, windDir, windLabel,
} from '../lib/conditions.js';
import {formatClock} from '../lib/timeFormat.js';
import {vertical} from './chart.js';

function daySummary(day, units) {
    const {temp: unit, wind: windUnit} = units;
    let s = weatherDesc(day.code);
    if (day.code2 !== null)
        s += `, at times ${weatherDesc(day.code2).toLowerCase()}`;
    if (day.precip > 20)
        s += `. ${day.precip}% chance of rain`;
    else if (day.precip > 0)
        s += ` with a ${day.precip}% chance of rain`;
    const wind = windLabel(day.windMax, windUnit);
    if (wind !== 'Calm' && wind !== 'Light')
        s += `. ${wind} winds ${windDir(day.windDir)} ${day.windMax} ${windUnit}`;
    s += `. High ${day.high}${unit}, low ${day.low}${unit}.`;
    return s;
}

/**
 * @param {object} day        model.days entry
 * @param {object[]} hours    the model's hours on that day
 * @param {object} units      model.units
 * @param {object} opts
 * @param {string} opts.clockFormat
 * @param {string} opts.variant      'dark' | 'light'
 * @param {boolean} opts.coloredUv
 */
export function buildDayTooltip(day, hours, units, {clockFormat, variant, coloredUv}) {
    const unit = units.temp;
    const avg = key => Math.round(hours.reduce((s, h) => s + h[key], 0) / hours.length);
    const max = key => Math.max(...hours.map(h => h[key]));

    const box = new St.BoxLayout({style_class: 'cw-tooltip', ...vertical()});

    const top = new St.BoxLayout({style_class: 'cw-tooltip-top'});
    top.add_child(new St.Icon({icon_name: iconName(day.code), style_class: 'cw-tooltip-icon'}));
    top.add_child(new St.Label({
        text: weatherDesc(day.code),
        style_class: 'cw-tooltip-title',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(top);

    const summary = new St.Label({text: daySummary(day, units), style_class: 'cw-tooltip-summary'});
    summary.clutter_text.line_wrap = true;
    summary.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    box.add_child(summary);

    const hilo = new St.BoxLayout({style_class: 'cw-tooltip-hilo'});
    hilo.add_child(new St.Label({text: `H ${day.high}${unit}`, style_class: 'cw-temp'}));
    hilo.add_child(new St.Label({text: `L ${day.low}${unit}`, style_class: 'cw-dim'}));
    if (hours.length > 0)
        hilo.add_child(new St.Label({text: `Feels ${avg('feels')}${unit}`, style_class: 'cw-dim'}));
    box.add_child(hilo);

    const detail = (key, value, color = null) => {
        const row = new St.BoxLayout({style_class: 'cw-tooltip-detail'});
        row.add_child(new St.Label({text: key, style_class: 'cw-tooltip-key'}));
        const label = new St.Label({text: value});
        if (color)
            label.style = `color: ${color};`;
        row.add_child(label);
        box.add_child(row);
    };
    if (hours.length > 0) {
        detail('Humidity', `${avg('humidity')}%`);
        const maxUv = max('uv');
        if (maxUv > 0) {
            const uv = uvStyle(maxUv, variant);
            detail('UV index', `${maxUv} ${uv.label}`, coloredUv ? uv.color : null);
        }
        detail('Wind', `${max('wind')} ${units.wind}`);
    }
    detail('Rain', `${day.precip}%`, PRECIP_COLORS[variant]);
    if (day.sunrise && day.sunset)
        detail('Daylight', `${formatClock(day.sunrise, clockFormat)} – ${formatClock(day.sunset, clockFormat)}`);

    const periods = [
        ['Morning', h => h.hour >= 6 && h.hour < 12],
        ['Afternoon', h => h.hour >= 12 && h.hour < 18],
        ['Evening', h => h.hour >= 18 && h.hour < 22],
        ['Night', h => h.hour >= 22 || h.hour < 6],
    ].map(([name, match]) => [name, hours.filter(match)]).filter(([, ph]) => ph.length > 0);

    if (periods.length > 0) {
        const list = new St.BoxLayout({style_class: 'cw-tooltip-periods', ...vertical()});
        for (const [name, ph] of periods) {
            const row = new St.BoxLayout({style_class: 'cw-tooltip-period'});
            row.add_child(new St.Icon({
                icon_name: iconName(dominantCode(ph), ph[Math.floor(ph.length / 2)].isDay),
                style_class: 'cw-tooltip-period-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({text: name, style_class: 'cw-tooltip-period-name'}));
            row.add_child(new St.Label({
                text: `${Math.round(ph.reduce((s, h) => s + h.temp, 0) / ph.length)}${unit}`,
            }));
            row.add_child(new St.Label({
                text: `${Math.max(...ph.map(h => h.precip))}%`,
                style_class: 'cw-precip',
            }));
            list.add_child(row);
        }
        box.add_child(list);
    }
    return box;
}
