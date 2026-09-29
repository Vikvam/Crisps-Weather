/*
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Hourly charts for one day, stacked on a shared hour axis:
//   temperature  line, left axis; UV index as bars on the right axis
//   rain         chance as a line, left axis; amount as bars on the right axis
//   wind         speed line, dashed gusts, direction arrows
//   humidity     line
//   air quality  bars
// Only enabled series are drawn. Hovering any panel moves a common marker and
// shows that hour in the readout line above. Night hours are shaded.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {
    PRECIP_COLORS, alignedTicks, aqiStyle, formatAmount, hexToRgb, iconName, tempColor,
    temperatureTicks, uvStyle, valueTicks, windArrow,
} from '../lib/conditions.js';
import {formatHour} from '../lib/timeFormat.js';

export const SLOTS = 24;
const LABEL_EVERY = 3;

/**
 * @param {object} opts
 * @param {Array<object|null>} opts.slots  SLOTS entries: an hour from the model or null
 * @param {object} opts.series             enabled series: {precip, rain, wind, uv, feels, humidity, aqi}
 * @param {object} opts.units              model.units
 * @param {string} opts.nowTime            the current hour's time
 * @param {string} opts.clockFormat        '12h' | '24h'
 * @param {boolean} opts.colored           colour the temperature line
 * @param {boolean} opts.coloredUv         colour UV bars by level
 * @param {string} opts.variant            'dark' | 'light'
 * @param {function(object): string} opts.describe  readout text for an hour
 * @returns {St.BoxLayout}
 */
export function buildChart(opts) {
    const {slots, series, units, nowTime, clockFormat, describe} = opts;
    const filled = slots.map((h, i) => (h ? i : -1)).filter(i => i >= 0);
    const nowSlot = slots.findIndex(h => h?.time === nowTime);
    const defaultSlot = nowSlot >= 0 ? nowSlot : filled[0];
    const state = {hovered: defaultSlot};
    const ctx = {...opts, filled, nowSlot, state};

    const box = new St.BoxLayout({style_class: 'cw-chart', x_expand: true, ...vertical()});
    // The readout's text changes with every hovered hour. It must not ask for
    // width (or the whole popup would resize as the pointer moves), so it
    // wraps within the width it gets and always keeps room for two lines.
    const readout = new St.Label({style_class: 'cw-chart-readout', x_expand: true});
    readout.natural_width = 0;
    readout.clutter_text.line_wrap = true;
    readout.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
    readout.clutter_text.line_alignment = Pango.Alignment.CENTER;
    readout.text = describe(slots[defaultSlot]);
    box.add_child(readout);

    // Icons and hour labels at every third slot.
    const marks = [];
    for (let s = 0; s < SLOTS; s += LABEL_EVERY) {
        const hour = slots.slice(s, s + LABEL_EVERY).find(Boolean);
        if (!hour)
            continue;
        marks.push({
            slot: slots.indexOf(hour),
            icon: new St.Icon({icon_name: iconName(hour.code, hour.isDay), style_class: 'cw-chart-icon'}),
            label: new St.Label({text: formatHour(hour.time, clockFormat), style_class: 'cw-chart-hour'}),
        });
    }
    box.add_child(positionedRow(marks, m => m.icon, 'cw-chart-icons'));

    const areas = [];
    const setHovered = slot => {
        if (slot < 0 || slot === state.hovered || !slots[slot])
            return;
        state.hovered = slot;
        readout.text = describe(slots[slot]);
        areas.forEach(a => a.queue_repaint());
    };

    const panels = [{id: 'temp', title: series.uv ? `Temperature (${units.temp})  ·  UV index (bars, right)` : null}];
    if (series.precip || series.rain) {
        const parts = [];
        if (series.precip)
            parts.push('Rain chance (%)');
        if (series.rain)
            parts.push(series.precip ? `amount (${units.rain}, bars, right)` : `Rain (${units.rain})`);
        panels.push({id: 'rain', title: parts.join('  ·  ')});
    }
    if (series.wind)
        panels.push({id: 'wind', title: `Wind and gusts (${units.wind})`});
    if (series.humidity)
        panels.push({id: 'humidity', title: 'Relative humidity (%)'});
    if (series.aqi)
        panels.push({id: 'aqi', title: 'Air quality (European AQI)'});

    // The extra panels scroll below the temperature chart when they don't fit.
    const extras = new St.BoxLayout({x_expand: true, ...vertical()});
    for (const {id, title} of panels) {
        const parent = id === 'temp' ? box : extras;
        if (title)
            parent.add_child(new St.Label({text: title, style_class: 'cw-chart-title'}));
        const area = new St.DrawingArea({
            style_class: id === 'temp' ? 'cw-chart-area' : 'cw-chart-area cw-chart-area-small',
            x_expand: true,
            reactive: true,
        });
        area.connect('repaint', () => {
            const cr = area.get_context();
            try {
                const [w, h] = area.get_surface_size();
                paint(cr, area, w, h, id, ctx);
            } finally {
                cr.$dispose();
            }
        });
        area.connect('motion-event', (_a, event) => {
            setHovered(slotAt(area, event));
            return Clutter.EVENT_PROPAGATE;
        });
        area.connect('leave-event', () => {
            setHovered(defaultSlot);
            return Clutter.EVENT_PROPAGATE;
        });
        areas.push(area);
        parent.add_child(area);
        if (id === 'temp')
            box.add_child(positionedRow(marks, m => m.label, 'cw-chart-hours'));
    }

    if (panels.length > 1) {
        const scroll = new St.ScrollView({
            style_class: 'cw-chart-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.child = extras;
        box.add_child(scroll);
    }
    return box;
}

// St.BoxLayout's `vertical` is deprecated since GNOME 48 in favour of `orientation`.
export function vertical() {
    return 'orientation' in St.BoxLayout.prototype
        ? {orientation: Clutter.Orientation.VERTICAL}
        : {vertical: true};
}

// Margins for the axis labels left and right of the plots (`-cw-axis-width`
// and `-cw-axis-right-width` in the stylesheet, so they scale with the text).
// Shared by the plots and the icon/hour rows, which must line up.
function axisMargins(actor) {
    const node = actor.get_theme_node();
    const [hasLeft, left] = node.lookup_length('-cw-axis-width', true);
    const [hasRight, right] = node.lookup_length('-cw-axis-right-width', true);
    return {left: hasLeft ? left : 0, right: hasRight ? right : 0};
}

function slotX(slot, width, {left, right}) {
    return left + (slot + 0.5) * (width - left - right) / SLOTS;
}

function slotAt(area, event) {
    const [x, y] = event.get_coords();
    const [ok, lx] = area.transform_stage_point(x, y);
    const {left, right} = axisMargins(area);
    const plotW = area.width - left - right;
    if (!ok || plotW <= 0)
        return -1;
    return Math.max(0, Math.min(SLOTS - 1, Math.floor((lx - left) / (plotW / SLOTS))));
}

// Lays children out on one line, each centred on the x of its `slot`
// (clamped to the row), so icons and labels line up with the plots.
const SlotLayout = GObject.registerClass(
class SlotLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(container, forHeight) {
        let min = 0;
        for (const child of container.get_children()) {
            const [childMin] = child.get_preferred_width(forHeight);
            min = Math.max(min, childMin);
        }
        return [min, min];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let min = 0, nat = 0;
        for (const child of container.get_children()) {
            const [childMin, childNat] = child.get_preferred_height(-1);
            min = Math.max(min, childMin);
            nat = Math.max(nat, childNat);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const height = box.get_height();
        const margins = axisMargins(container);
        for (const child of container.get_children()) {
            const [, natW] = child.get_preferred_width(-1);
            const [, natH] = child.get_preferred_height(natW);
            const x = Math.round(Math.max(0, Math.min(slotX(child._slot, width, margins) - natW / 2, width - natW)));
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(box.x1 + x, box.y1 + Math.round((height - natH) / 2));
            childBox.set_size(natW, natH);
            child.allocate(childBox);
        }
    }
});

function positionedRow(marks, actorOf, styleClass) {
    const row = new St.Widget({style_class: styleClass, layout_manager: new SlotLayout(), x_expand: true});
    for (const m of marks) {
        const actor = actorOf(m);
        actor._slot = m.slot;
        row.add_child(actor);
    }
    return row;
}

// ---- Painting ----

// Left and (optional) right axis scales of a panel. A right scale uses the
// same number of intervals as the left one, so both share the grid lines.
function panelScales(panel, values, ctx) {
    const {series, units} = ctx;
    const max = key => Math.max(0, ...values(key));
    const intervals = scale => scale.ticks.length - 1;
    switch (panel) {
    case 'temp': {
        const temps = values('temp').concat(series.feels ? values('feels') : []);
        const left = temperatureTicks(Math.min(...temps), Math.max(...temps));
        return {left, right: series.uv ? alignedTicks(max('uv'), intervals(left), intervals(left)) : null};
    }
    case 'rain': {
        const minRain = units.rain === 'in' ? 0.1 : 2;
        if (!series.precip)
            return {left: valueTicks(max('rain'), minRain), right: null};
        const left = {lo: 0, hi: 100, ticks: [0, 50, 100]};
        return {left, right: series.rain ? alignedTicks(max('rain'), minRain, intervals(left)) : null};
    }
    case 'wind':
        return {left: valueTicks(Math.max(max('gust'), max('wind')), 10), right: null};
    case 'humidity':
        return {left: {lo: 0, hi: 100, ticks: [0, 50, 100]}, right: null};
    default: // 'aqi'
        return {left: valueTicks(max('aqi'), 40), right: null};
    }
}

function paint(cr, area, w, h, panel, ctx) {
    const {slots, filled, nowSlot, state, units, variant, series} = ctx;
    const node = area.get_theme_node();
    const fg = node.get_foreground_color();
    const fgRgb = [fg.red / 255, fg.green / 255, fg.blue / 255];
    const font = node.get_font();
    const margins = axisMargins(area);
    const step = (w - margins.left - margins.right) / SLOTS;
    // Room for half an axis label above the top and below the bottom grid line.
    const top = panel === 'wind' ? 18 : 8;
    const bottom = 8;
    const plotH = h - top - bottom;
    const baseline = h - bottom;
    const x = slot => slotX(slot, w, margins);
    const values = key => filled.map(s => slots[s][key]).filter(v => typeof v === 'number');
    const scales = panelScales(panel, values, ctx);
    const yOn = scale => v => top + plotH * (1 - (v - scale.lo) / (scale.hi - scale.lo));
    const yLeft = yOn(scales.left);
    const yRight = scales.right ? yOn(scales.right) : null;
    const precipRgb = hexToRgb(PRECIP_COLORS[variant] ?? PRECIP_COLORS.dark);

    // Night shading.
    cr.setSourceRGBA(...fgRgb, 0.05);
    for (const s of filled) {
        if (!slots[s].isDay)
            cr.rectangle(x(s) - step / 2, 0, step, h);
    }
    cr.fill();

    // Axes: grid lines for the left scale, labels on both sides.
    cr.setLineWidth(1);
    const label = (key, t) => {
        if (key === 'temp')
            return `${t}°`;
        if (key === 'rain' && !Number.isInteger(t))
            return formatAmount(t, units.rain);
        return String(t);
    };
    const leftKey = panel === 'rain' && series.precip ? 'precip' : panel;
    for (const t of scales.left.ticks) {
        const gy = Math.round(yLeft(t)) + 0.5;
        cr.setSourceRGBA(...fgRgb, 0.12);
        cr.moveTo(margins.left, gy);
        cr.lineTo(w - margins.right, gy);
        cr.stroke();
        drawText(cr, font, label(leftKey, t), margins.left - 4, gy, fgRgb, 0.6, 'right');
    }
    if (scales.right) {
        const rightKey = panel === 'temp' ? 'uv' : 'rain';
        for (const t of scales.right.ticks)
            drawText(cr, font, label(rightKey, t), w - margins.right + 4, yRight(t), fgRgb, 0.6, 'left');
    }

    // Now and hover markers, through every panel.
    const vline = (slot, alpha) => {
        const vx = Math.round(x(slot)) + 0.5;
        cr.setSourceRGBA(...fgRgb, alpha);
        cr.moveTo(vx, 0);
        cr.lineTo(vx, h);
        cr.stroke();
    };
    if (nowSlot >= 0)
        vline(nowSlot, 0.45);
    if (state.hovered !== nowSlot && slots[state.hovered])
        vline(state.hovered, 0.25);

    const draw = {
        bars(key, yOf, colorOf, alpha, hi) {
            for (const s of filled) {
                const v = slots[s][key];
                if (typeof v !== 'number' || v <= 0)
                    continue;
                const y = yOf(Math.min(v, hi));
                cr.setSourceRGBA(...colorOf(v), s === state.hovered ? Math.min(1, alpha + 0.3) : alpha);
                cr.rectangle(x(s) - step * 0.35, y, step * 0.7, baseline - y);
                cr.fill();
            }
        },
        // Smooth curve through the hours with values, as a path (not stroked).
        path(key, yOf) {
            const pts = filled.filter(s => typeof slots[s][key] === 'number');
            pts.forEach((s, k) => {
                const px = x(s);
                const py = yOf(slots[s][key]);
                if (k === 0) {
                    cr.moveTo(px, py);
                    return;
                }
                // Horizontal-tangent Béziers: smooth, never overshoot.
                const cx = (x(pts[k - 1]) + px) / 2;
                cr.curveTo(cx, yOf(slots[pts[k - 1]][key]), cx, py, px, py);
            });
            return pts;
        },
        line(key, yOf, setSource, width, dash = []) {
            if (draw.path(key, yOf).length === 0)
                return;
            setSource();
            cr.setLineWidth(width);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setDash(dash, 0);
            cr.stroke();
            cr.setDash([], 0);
        },
        dot(s, key, yOf, rgb, radius) {
            const v = slots[s]?.[key];
            if (typeof v !== 'number')
                return;
            cr.setSourceRGBA(...rgb, 1);
            cr.arc(x(s), yOf(v), radius, 0, 2 * Math.PI);
            cr.fill();
        },
    };

    switch (panel) {
    case 'temp':
        // Bars first, so the temperature curve stays on top.
        if (series.uv) {
            const uvColor = v => (ctx.coloredUv ? hexToRgb(uvStyle(v, variant).color) : fgRgb);
            draw.bars('uv', yRight, uvColor, 0.35, scales.right.hi);
        }
        paintTemperature(cr, ctx, {x, yOf: yLeft, baseline, draw, fgRgb});
        break;
    case 'rain':
        if (series.precip && series.rain)
            draw.bars('rain', yRight, () => precipRgb, 0.45, scales.right.hi);
        else if (series.rain)
            draw.bars('rain', yLeft, () => precipRgb, 0.75, scales.left.hi);
        if (series.precip) {
            draw.line('precip', yLeft, () => cr.setSourceRGBA(...precipRgb, 1), 2);
            draw.dot(state.hovered, 'precip', yLeft, precipRgb, 3);
        }
        break;
    case 'wind':
        draw.line('gust', yLeft, () => cr.setSourceRGBA(...fgRgb, 0.45), 1.5, [3, 3]);
        draw.line('wind', yLeft, () => cr.setSourceRGBA(...fgRgb, 0.9), 2);
        draw.dot(state.hovered, 'wind', yLeft, fgRgb, 3);
        // Direction (where the wind blows to) along the top, every third hour.
        for (let s = 1; s < SLOTS; s += LABEL_EVERY) {
            if (slots[s])
                drawText(cr, font, windArrow(slots[s].windDir), x(s), 7, fgRgb, 0.7, 'center');
        }
        break;
    case 'humidity':
        draw.line('humidity', yLeft, () => cr.setSourceRGBA(...fgRgb, 0.85), 2);
        draw.dot(state.hovered, 'humidity', yLeft, fgRgb, 3);
        break;
    case 'aqi':
        draw.bars('aqi', yLeft, v => hexToRgb(aqiStyle(v, variant).color), 0.7, scales.left.hi);
        break;
    }
}

function paintTemperature(cr, ctx, {x, yOf, baseline, draw, fgRgb}) {
    const {slots, filled, units, colored, variant, series, nowSlot, state} = ctx;
    const temps = filled.map(s => slots[s].temp);
    const tMax = Math.max(...temps);
    const tMin = Math.min(...temps);
    const colorOf = t => hexToRgb(tempColor(t, units.temp, variant));
    const source = alpha => {
        if (!colored) {
            cr.setSourceRGBA(...fgRgb, alpha);
        } else if (tMax === tMin) {
            cr.setSourceRGBA(...colorOf(tMax), alpha);
        } else {
            const gradient = new Cairo.LinearGradient(0, yOf(tMax), 0, yOf(tMin));
            for (let k = 0; k <= 8; k++)
                gradient.addColorStopRGBA(k / 8, ...colorOf(tMax - (tMax - tMin) * k / 8), alpha);
            cr.setSource(gradient);
        }
    };

    // Area under the curve (lighter when UV bars share the panel).
    const pts = draw.path('temp', yOf);
    if (pts.length > 1) {
        cr.lineTo(x(pts[pts.length - 1]), baseline);
        cr.lineTo(x(pts[0]), baseline);
        cr.closePath();
        source(series.uv ? 0.06 : 0.12);
        cr.fill();
    } else {
        cr.newPath();
    }
    if (series.feels)
        draw.line('feels', yOf, () => cr.setSourceRGBA(...fgRgb, 0.5), 1.5, [4, 3]);
    draw.line('temp', yOf, () => source(1), 2);

    const pointColor = s => (colored ? colorOf(slots[s].temp) : fgRgb);
    if (nowSlot >= 0)
        draw.dot(nowSlot, 'temp', yOf, pointColor(nowSlot), 3);
    if (slots[state.hovered])
        draw.dot(state.hovered, 'temp', yOf, pointColor(state.hovered), 4);
}

function drawText(cr, font, text, x, y, rgb, alpha, align) {
    const layout = PangoCairo.create_layout(cr);
    const desc = font.copy();
    desc.set_size(Math.round(desc.get_size() * 0.8));
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    let left = x;
    if (align === 'center')
        left -= logical.width / 2;
    else if (align === 'right')
        left -= logical.width;
    cr.setSourceRGBA(...rgb, alpha);
    // `y` is the vertical centre of the text.
    cr.moveTo(Math.max(0, left), y - logical.height / 2);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
}
