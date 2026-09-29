/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Formatting of Open-Meteo wall-clock strings ("2026-09-29T14:00", or a bare
// date "2026-09-29"). The strings are already in the location's local time,
// so they are interpreted in UTC purely as a neutral carrier: no conversion
// through the system timezone ever happens.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UTC = GLib.TimeZone.new_utc();

function toDateTime(wall) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(wall ?? '');
    if (!m)
        return null;
    return GLib.DateTime.new(UTC, +m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), 0);
}

function format(wall, pattern) {
    return toDateTime(wall)?.format(pattern)?.trim() ?? '';
}

/** "14:00" or "2 PM" */
export function formatHour(wall, clockFormat) {
    return format(wall, clockFormat === '12h' ? '%-l %p' : '%H:%M');
}

/** "06:42" or "6:42 AM" */
export function formatClock(wall, clockFormat) {
    return format(wall, clockFormat === '12h' ? '%-l:%M %p' : '%H:%M');
}

/** A unix timestamp as a clock time in the *system* timezone, e.g. "Updated 14:05". */
export function formatUnixClock(unix, clockFormat) {
    const dt = GLib.DateTime.new_from_unix_local(unix);
    return dt?.format(clockFormat === '12h' ? '%-l:%M %p' : '%H:%M')?.trim() ?? '';
}

/** Locale weekday, "Mon" / "Monday" */
export function formatWeekday(wall, long = false) {
    return format(wall, long ? '%A' : '%a');
}

/** Locale short date, "Sep 29" */
export function formatShortDate(wall) {
    return format(wall, '%b %-d');
}

/**
 * Resolve the effective clock format ('12h' | '24h').
 * `pref` is the extension's `clock-format` setting: 'system' | '12h' | '24h'.
 * `interfaceSettings` is a Gio.Settings for org.gnome.desktop.interface.
 */
export function resolveClockFormat(pref, interfaceSettings) {
    if (pref === '12h' || pref === '24h')
        return pref;
    return interfaceSettings?.get_string('clock-format') === '12h' ? '12h' : '24h';
}

export function createInterfaceSettings() {
    return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
}
