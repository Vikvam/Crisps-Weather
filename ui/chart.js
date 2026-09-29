/*
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Hourly chart: temperature line over precipitation-chance bars for 24 hour
// slots, with weather icons and hour labels every three hours. Hovering a slot
// shows its details in the readout line above the chart.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {PRECIP_COLORS, hexToRgb, iconName, tempColor, weatherDesc} from '../lib/conditions.js';
import {formatHour, formatWeekday} from '../lib/timeFormat.js';

export const SLOTS = 24;
const LABEL_EVERY = 3;
const ICON_SIZE = 16;

/**
 * @param {object} opts
 * @param {Array<object|null>} opts.slots  SLOTS entries: an hour from the model or null
 * @param {object} opts.units              model.units
 * @param {string} opts.nowTime            hour slot to mark as "now" (model.hours[0].time)
 * @param {string} opts.clockFormat        '12h' | '24h'
 * @param {boolean} opts.colored           colour the line by temperature
 * @param {boolean} opts.showUv            include UV in the readout
 * @param {string} opts.variant            'dark' | 'light'
 * @returns {St.BoxLayout}
 */
export function buildChart({slots, units, nowTime, clockFormat, colored, showUv, variant}) {
    const filled = slots.map((h, i) => (h ? i : -1)).filter(i => i >= 0);
    const temps = filled.map(i => slots[i].temp);
    const tMax = Math.max(...temps);
    const tMin = Math.min(...temps);
    const nowSlot = slots.findIndex(h => h?.time === nowTime);
    const defaultSlot = nowSlot >= 0 ? nowSlot : filled[0];
    let hovered = defaultSlot;

    const box = new St.BoxLayout({style_class: 'cw-chart', x_expand: true, ...vertical()});

    const readout = new St.Label({style_class: 'cw-chart-readout', x_align: Clutter.ActorAlign.CENTER});
    const describe = slot => {
        const h = slots[slot];
        if (!h)
            return '';
        const parts = [
            h.time === nowTime ? 'Now' : formatHour(h.time, clockFormat),
            `${h.temp}${units.temp}`,
            weatherDesc(h.code),
            `${h.precip}% rain`,
        ];
        if (showUv && h.isDay && h.uv > 0)
            parts.push(`UV ${h.uv}`);
        return parts.join('  ·  ');
    };
    readout.text = describe(hovered);
    box.add_child(readout);

    const area = new St.DrawingArea({style_class: 'cw-chart-area', x_expand: true, reactive: true});
    area.connect('repaint', () => {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            paint(cr, area.get_theme_node(), w, h, {slots, filled, tMin, tMax, nowSlot, hovered, units, colored, variant});
        } finally {
            cr.$dispose();
        }
    });
    const slotAt = event => {
        const [x, y] = event.get_coords();
        const [ok, lx] = area.transform_stage_point(x, y);
        if (!ok || area.width <= 0)
            return -1;
        return Math.max(0, Math.min(SLOTS - 1, Math.floor(lx / (area.width / SLOTS))));
    };
    const setHovered = slot => {
        if (slot === hovered || !slots[slot])
            return;
        hovered = slot;
        readout.text = describe(slot);
        area.queue_repaint();
    };
    area.connect('motion-event', (_a, event) => {
        setHovered(slotAt(event));
        return Clutter.EVENT_PROPAGATE;
    });
    area.connect('leave-event', () => {
        setHovered(defaultSlot);
        return Clutter.EVENT_PROPAGATE;
    });
    box.add_child(area);

    // Icons and hour labels sit at the x of every third slot. They are real
    // actors (themed, crisp), positioned whenever the row width changes.
    const marks = [];
    for (let s = 0; s < SLOTS; s += LABEL_EVERY) {
        // Prefer the slot itself; on a partial day fall back to the next hours.
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
    box.add_child(positionedRow(marks, m => m.label, 'cw-chart-hours'));
    return box;
}

// St.BoxLayout's `vertical` is deprecated since GNOME 48 in favour of `orientation`.
export function vertical() {
    return 'orientation' in St.BoxLayout.prototype
        ? {orientation: Clutter.Orientation.VERTICAL}
        : {vertical: true};
}

function slotX(slot, width) {
    return (slot + 0.5) * width / SLOTS;
}

// Lays children out on one line, each centred on the x of its `slot`
// (clamped to the row), so icons and labels line up with the chart's points.
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

    vfunc_get_preferred_height(container, forWidth) {
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
        for (const child of container.get_children()) {
            const [, natW] = child.get_preferred_width(-1);
            const [, natH] = child.get_preferred_height(natW);
            const x = Math.round(Math.max(0, Math.min(slotX(child._slot, width) - natW / 2, width - natW)));
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

function paint(cr, node, w, h, {slots, filled, tMin, tMax, nowSlot, hovered, units, colored, variant}) {
    const fg = node.get_foreground_color();
    const fgRgb = [fg.red / 255, fg.green / 255, fg.blue / 255];
    const font = node.get_font();
    const top = 16;
    const bottom = 20;
    const plotH = h - top - bottom;
    const range = Math.max(tMax - tMin, 4);
    const mid = (tMax + tMin) / 2;
    const yOf = t => top + plotH * (1 - ((t - (mid - range / 2)) / range));
    const x = slot => slotX(slot, w);
    const step = w / SLOTS;

    // Precipitation chance: bars from the bottom edge, full height = 100%.
    const [pr, pg, pb] = hexToRgb(PRECIP_COLORS[variant] ?? PRECIP_COLORS.dark);
    cr.setSourceRGBA(pr, pg, pb, 0.35);
    for (const s of filled) {
        const p = slots[s].precip;
        if (p <= 0)
            continue;
        const barH = (h - top) * p / 100;
        cr.rectangle(x(s) - step * 0.35, h - barH, step * 0.7, barH);
    }
    cr.fill();

    // Day boundaries on multi-day pages.
    cr.setLineWidth(1);
    cr.setDash([3, 3], 0);
    for (const s of filled) {
        if (s === 0 || slots[s].hour !== 0)
            continue;
        const bx = Math.round(x(s) - step / 2) + 0.5;
        cr.setSourceRGBA(...fgRgb, 0.3);
        cr.moveTo(bx, 0);
        cr.lineTo(bx, h);
        cr.stroke();
        drawText(cr, font, formatWeekday(slots[s].date), bx + 3, 0, fgRgb, 0.6, 'left');
    }
    cr.setDash([], 0);

    // Hover guide.
    if (hovered >= 0 && slots[hovered]) {
        cr.setSourceRGBA(...fgRgb, 0.25);
        cr.moveTo(Math.round(x(hovered)) + 0.5, top - 4);
        cr.lineTo(Math.round(x(hovered)) + 0.5, h);
        cr.stroke();
    }

    // Temperature line, smoothed with horizontal-tangent Béziers (no overshoot).
    const tracePath = () => {
        filled.forEach((s, k) => {
            const px = x(s);
            const py = yOf(slots[s].temp);
            if (k === 0) {
                cr.moveTo(px, py);
                return;
            }
            const prev = filled[k - 1];
            const qx = x(prev);
            const qy = yOf(slots[prev].temp);
            const cx = (qx + px) / 2;
            cr.curveTo(cx, qy, cx, py, px, py);
        });
    };
    const lineSource = alpha => {
        if (!colored) {
            cr.setSourceRGBA(...fgRgb, alpha);
            return null;
        }
        if (tMax === tMin) {
            cr.setSourceRGBA(...hexToRgb(tempColor(tMax, units.temp, variant)), alpha);
            return null;
        }
        const gradient = new Cairo.LinearGradient(0, yOf(tMax), 0, yOf(tMin));
        const stops = 8;
        for (let k = 0; k <= stops; k++) {
            const t = tMax - (tMax - tMin) * k / stops;
            gradient.addColorStopRGBA(k / stops, ...hexToRgb(tempColor(t, units.temp, variant)), alpha);
        }
        cr.setSource(gradient);
        return gradient;
    };

    if (filled.length > 1) {
        tracePath();
        cr.lineTo(x(filled[filled.length - 1]), h);
        cr.lineTo(x(filled[0]), h);
        cr.closePath();
        lineSource(0.12);
        cr.fill();

        tracePath();
        lineSource(1);
        cr.setLineWidth(2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
    }

    const dot = (s, radius) => {
        const t = slots[s].temp;
        if (colored)
            cr.setSourceRGBA(...hexToRgb(tempColor(t, units.temp, variant)), 1);
        else
            cr.setSourceRGBA(...fgRgb, 1);
        cr.arc(x(s), yOf(t), radius, 0, 2 * Math.PI);
        cr.fill();
    };
    if (nowSlot >= 0)
        dot(nowSlot, 3);
    if (hovered >= 0 && slots[hovered])
        dot(hovered, 4);

    // Label the warmest and coldest hour.
    const maxSlot = filled.find(s => slots[s].temp === tMax);
    const minSlot = filled.find(s => slots[s].temp === tMin);
    drawText(cr, font, `${tMax}°`, x(maxSlot), yOf(tMax) - 15, fgRgb, 0.9, 'center', w);
    if (minSlot !== maxSlot)
        drawText(cr, font, `${tMin}°`, x(minSlot), yOf(tMin) + 3, fgRgb, 0.7, 'center', w);
}

function drawText(cr, font, text, x, y, rgb, alpha, align, maxX = Infinity) {
    const layout = PangoCairo.create_layout(cr);
    const desc = font.copy();
    desc.set_size(Math.round(desc.get_size() * 0.8));
    layout.set_font_description(desc);
    layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    let left = align === 'center' ? x - logical.width / 2 : x;
    left = Math.max(0, Math.min(left, maxX - logical.width));
    cr.setSourceRGBA(...rgb, alpha);
    cr.moveTo(left, y);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
}
