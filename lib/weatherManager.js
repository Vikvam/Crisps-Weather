/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Owns everything that talks to the network: location resolution, forecast
// fetching, scheduling, retries and cancellation. The UI only listens:
//
//   'loading'            a refresh started
//   'updated' (model)    a new forecast is available (see openMeteo.normalize)
//   'error'   (error)    a refresh failed; the previous model (if any) is kept
//   'no-location'        no location could be resolved
//
// Uses the shell's EventEmitter, so it is only imported by extension.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {createSession, isCancelled} from './http.js';
import {
    geoclueLookup, ipLookup, locationId, locationServicesEnabled,
    readAutoCache, readFavorites, writeAutoCache,
} from './location.js';
import {fetchForecast} from './openMeteo.js';

// GLib timeouts use the monotonic clock, which stops during suspend. A short
// tick compares wall-clock age instead, so data is refreshed soon after resume.
const TICK_SECONDS = 5 * 60;
const RETRY_MINUTES = [1, 2, 5, 10];
const AUTO_LOCATION_TTL_SECONDS = 6 * 60 * 60;

const nowSeconds = () => Math.floor(GLib.get_real_time() / 1_000_000);

export class WeatherManager extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._session = createSession();
        this._cancellable = null;
        this._model = null;
        this._lastError = null;
        this._failures = 0;
        this._retryId = 0;

        this._settings.connectObject(
            'changed::active-location', () => this.refresh({force: true}),
            'changed::temperature-unit', () => this.refresh({force: true}),
            'changed::allow-ip-lookup', () => this._onAutoSourceChanged(),
            'changed::favorites', () => this._onFavoritesChanged(),
            // Re-detect in prefs clears the cache. We never listen to our own
            // non-empty writes, so this can't loop.
            'changed::auto-location-cache', () => {
                if (this._settings.get_string('auto-location-cache') === '')
                    this._onAutoSourceChanged();
            },
            this);

        Gio.NetworkMonitor.get_default().connectObject('network-changed', (_m, available) => {
            if (available && this.isStale())
                this.refresh();
        }, this);

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            if (!this._retryId && !this._cancellable && this.isStale())
                this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get model() {
        return this._model;
    }

    get lastError() {
        return this._lastError;
    }

    get busy() {
        return this._cancellable !== null;
    }

    get favorites() {
        return readFavorites(this._settings);
    }

    get activeId() {
        const id = this._settings.get_string('active-location');
        if (id !== 'auto' && !this.favorites.some(f => locationId(f) === id))
            return 'auto';
        return id;
    }

    isStale() {
        if (!this._model)
            return true;
        const intervalSeconds = this._settings.get_uint('refresh-interval') * 60;
        return nowSeconds() - this._model.fetchedAt >= intervalSeconds;
    }

    /**
     * Refresh the forecast. Without `force`, does nothing while data is fresh.
     * Any refresh in flight is cancelled, so an older response can never
     * overwrite a newer one.
     */
    async refresh({force = false} = {}) {
        if (!this._session || (!force && !this.isStale()))
            return;

        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._clearRetry();
        this.emit('loading');

        try {
            const location = await this._resolveLocation(cancellable);
            if (cancellable.is_cancelled())
                return;
            if (!location) {
                this._model = null;
                this._lastError = null;
                this.emit('no-location');
                return;
            }

            const fahrenheit = this._settings.get_string('temperature-unit') === 'fahrenheit';
            const model = await fetchForecast(this._session, location, {fahrenheit}, cancellable);
            if (cancellable.is_cancelled())
                return;

            this._model = model;
            this._lastError = null;
            this._failures = 0;
            this.emit('updated', model);
        } catch (e) {
            if (cancellable.is_cancelled() || isCancelled(e))
                return;
            this._lastError = e;
            this._failures++;
            console.warn(`Weather: refresh failed (attempt ${this._failures}): ${e.message ?? e}`);
            this._scheduleRetry();
            this.emit('error', e);
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearRetry();
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        this._settings.disconnectObject(this);
        Gio.NetworkMonitor.get_default().disconnectObject(this);
        this._session?.abort();
        this._session = null;
        this._model = null;
        this.disconnectAll();
    }

    _onFavoritesChanged() {
        // Only refetch when the location we show is affected, e.g. the active
        // favourite was removed (activeId then falls back to 'auto').
        const shown = this._model ? locationId(this._model.location) : null;
        const wanted = this.activeId;
        if (wanted === 'auto' ? this._showingFavorite() : wanted !== shown)
            this.refresh({force: true});
    }

    _showingFavorite() {
        if (!this._model)
            return true;
        const shown = locationId(this._model.location);
        const cached = readAutoCache(this._settings);
        return !cached || locationId(cached.location) !== shown;
    }

    _onAutoSourceChanged() {
        if (this.activeId === 'auto')
            this.refresh({force: true});
    }

    async _resolveLocation(cancellable) {
        const id = this.activeId;
        if (id !== 'auto')
            return this.favorites.find(f => locationId(f) === id);
        return this._resolveAuto(cancellable);
    }

    async _resolveAuto(cancellable) {
        const cached = readAutoCache(this._settings);
        if (cached && nowSeconds() - cached.timestamp < AUTO_LOCATION_TTL_SECONDS)
            return cached.location;

        let location = null;
        let source = null;
        if (locationServicesEnabled()) {
            location = await geoclueLookup(cancellable);
            source = 'geoclue';
        }
        if (!location && this._settings.get_boolean('allow-ip-lookup')) {
            try {
                location = await ipLookup(this._session, cancellable);
                source = 'ip';
            } catch (e) {
                // Prefer an expired cache over no location at all.
                if (cached && !isCancelled(e))
                    return cached.location;
                throw e;
            }
        }
        if (!location)
            return cached?.location ?? null;

        if (!cancellable.is_cancelled())
            writeAutoCache(this._settings, location, source);
        return location;
    }

    _scheduleRetry() {
        this._clearRetry();
        const step = RETRY_MINUTES[Math.min(this._failures, RETRY_MINUTES.length) - 1];
        const minutes = Math.min(step, this._settings.get_uint('refresh-interval'));
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._retryId = 0;
            this.refresh({force: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearRetry() {
        if (this._retryId) {
            GLib.Source.remove(this._retryId);
            this._retryId = 0;
        }
    }
}
