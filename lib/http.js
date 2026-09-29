/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Small JSON-over-HTTP helper shared by the extension and the preferences
// window. Must not import anything from resource:///org/gnome/shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Nominatim's usage policy requires an identifying User-Agent.
const USER_AGENT = 'CrispsWeather/1 (+https://github.com/Vikvam/Chips-Weather)';
const TIMEOUT_SECONDS = 20;

export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} from ${url}`);
        this.name = 'HttpError';
        this.status = status;
    }
}

export function createSession() {
    return new Soup.Session({user_agent: USER_AGENT, timeout: TIMEOUT_SECONDS});
}

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function buildUrl(url, params) {
    const query = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return query ? `${url}?${query}` : url;
}

/**
 * GET `url` with `params` and parse the body as JSON.
 * Throws HttpError on non-2xx, GLib.Error (CANCELLED) when cancelled.
 */
export async function getJson(session, url, params = {}, cancellable = null) {
    const fullUrl = buildUrl(url, params);
    const msg = Soup.Message.new('GET', fullUrl);
    if (!msg)
        throw new Error(`Invalid URL: ${fullUrl}`);
    msg.request_headers.append('Accept', 'application/json');

    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const status = msg.get_status();
    if (status < 200 || status >= 300)
        throw new HttpError(status, url);

    const data = bytes?.get_data();
    if (!data || data.length === 0)
        throw new Error(`Empty response from ${url}`);
    return JSON.parse(new TextDecoder().decode(data));
}
