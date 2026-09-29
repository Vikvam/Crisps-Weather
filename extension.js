/*
 * Copyright (C) 2026  chip
 * Copyright (C) 2026  Vikvam
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

//  Architecture
//  ------------
//  lib/weatherManager.js  location (favourite / GeoClue / ipinfo.io) → open-meteo.com
//                         7-day hourly + daily forecast, refresh scheduling, retries.
//  lib/openMeteo.js       normalizes the response into a model keyed by the
//                         location's local wall-clock time.
//  extension.js           this file: panel indicator + popup, driven by manager events.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {displayName, locationId, readAutoCache} from './lib/location.js';
import {
    createInterfaceSettings, formatClock, formatHour, formatShortDate,
    formatWeekday, resolveClockFormat,
} from './lib/timeFormat.js';
import {WeatherManager} from './lib/weatherManager.js';

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

// Short condition labels for hourly rows
const WEATHER_SHORT = {
    0: 'Clear', 1: 'Few Clouds', 2: 'Partly Cloudy', 3: 'Overcast',
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
const PER_PAGE = 8;
const PRECIP_COLOR = '#64b5f6';

function iconName(code, isDay) {
    if (!isDay && NIGHT_ICON_MAP[code] !== undefined)
        return NIGHT_ICON_MAP[code];
    return DAY_ICON_MAP[code] || 'weather-clear-symbolic';
}

function weatherDesc(code) {
    return WEATHER_SHORT[code] || 'Unknown';
}

function windDir(deg) {
    return WIND_DIRS[Math.round(deg / 22.5) % 16];
}

function windLabel(speed, unit) {
    const kmh = unit === 'mph' ? speed * 1.609 : speed;
    if (kmh < 5) return 'Calm';
    if (kmh < 20) return 'Light';
    if (kmh < 40) return 'Breezy';
    if (kmh < 60) return 'Windy';
    if (kmh < 80) return 'Strong';
    return 'Gusty';
}

function tempColor(t, unit) {
    if (unit === '°F') {
        if (t < 32) return '#64b5f6';
        if (t < 50) return '#42a5f5';
        if (t < 65) return '#26a69a';
        if (t < 75) return '#66bb6a';
        if (t < 85) return '#ffca28';
        if (t < 95) return '#ffa726';
        return '#ef5350';
    }
    if (t < 0) return '#64b5f6';
    if (t < 10) return '#42a5f5';
    if (t < 18) return '#26a69a';
    if (t < 24) return '#66bb6a';
    if (t < 30) return '#ffca28';
    if (t < 35) return '#ffa726';
    return '#ef5350';
}

function uvStyle(uv) {
    if (uv <= 2) return {color: '#8bc34a', label: 'Low'};
    if (uv <= 5) return {color: '#ffc107', label: 'Moderate'};
    if (uv <= 7) return {color: '#ff9800', label: 'High'};
    if (uv <= 10) return {color: '#f44336', label: 'Very High'};
    return {color: '#ce93d8', label: 'Extreme'};
}

// Extension lifecycle: enable() creates everything, disable() must destroy/disconnect all.
export default class WeatherExtension extends Extension {
    enable() {
        this._model = null;
        this._status = 'loading'; // 'loading' | 'ok' | 'error' | 'no-location'
        this._viewMode = 'hourly';
        this._forecastPage = 0;
        this._activeDate = null;
        this._bgContainer = null;
        this._tooltip = null;
        this._fadeInId = 0;
        this._fadeOutId = 0;

        this._settings = this.getSettings();
        this._interfaceSettings = createInterfaceSettings();

        this._settings.connectObject(
            'changed::panel-display', () => this._applyPanel(),
            'changed::temperature-position', () => this._applyPanel(),
            'changed::use-colored-temps', () => this._rebuildMenu(),
            'changed::use-colored-uv', () => this._rebuildMenu(),
            'changed::show-uv-index', () => this._rebuildMenu(),
            'changed::show-precipitation', () => this._rebuildMenu(),
            'changed::clock-format', () => this._rebuildMenu(),
            'changed::favorites', () => this._rebuildMenu(),
            'changed::active-location', () => this._rebuildMenu(),
            this);
        this._interfaceSettings.connectObject(
            'changed::clock-format', () => this._rebuildMenu(), this);

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._indicator.menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open) {
                this._hideTooltip();
                return;
            }
            this._manager?.refresh();
            this._fadeIn(8);
        }, this);

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'weather-clear-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '--°',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0 4px; font-weight: bold; font-size: 11px;',
        });
        this._indicator.add_child(this._box);
        this._applyPanel();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._manager = new WeatherManager(this._settings);
        this._manager.connect('loading', () => {
            if (!this._model) {
                this._status = 'loading';
                this._rebuildMenu();
            }
        });
        this._manager.connect('updated', (_m, model) => this._onUpdated(model));
        this._manager.connect('error', () => {
            this._status = 'error';
            this._rebuildMenu();
        });
        this._manager.connect('no-location', () => {
            this._model = null;
            this._status = 'no-location';
            this._applyPanel();
            this._rebuildMenu();
        });

        this._rebuildMenu();
        this._manager.refresh({force: true});
    }

    disable() {
        this._manager?.destroy();
        this._manager = null;
        this._clearFades();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._interfaceSettings?.disconnectObject(this);
        this._interfaceSettings = null;
        this._hideTooltip();
        this._indicator?.menu.disconnectObject(this);
        // Destroys the menu, the box, icon and label with it.
        this._indicator?.destroy();
        this._indicator = null;
        this._box = null;
        this._icon = null;
        this._label = null;
        this._bgContainer = null;
        this._model = null;
    }

    _onUpdated(model) {
        const moved = !this._model || locationId(this._model.location) !== locationId(model.location);
        this._model = model;
        this._status = 'ok';
        if (moved) {
            this._forecastPage = 0;
            this._activeDate = null;
        } else if (this._activeDate && !model.days.some(d => d.date === this._activeDate)) {
            this._activeDate = null;
        }
        this._applyPanel();
        this._rebuildMenu();
    }

    _clockFormat() {
        return resolveClockFormat(this._settings.get_string('clock-format'), this._interfaceSettings);
    }

    // ---- Panel ----

    _applyPanel() {
        if (!this._box)
            return;
        const mode = this._settings.get_string('panel-display');
        const current = this._model?.current;
        this._label.text = current ? `${current.temp}${this._model.units.temp}` : '--°';
        this._icon.icon_name = current ? iconName(current.code, current.isDay) : 'weather-clear-symbolic';

        this._box.remove_all_children();
        if (mode === 'icon') {
            this._box.add_child(this._icon);
        } else if (mode === 'temp-icon') {
            const tempFirst = this._settings.get_string('temperature-position') === 'left';
            this._box.add_child(tempFirst ? this._label : this._icon);
            this._box.add_child(tempFirst ? this._icon : this._label);
        } else {
            this._box.add_child(this._label);
        }
    }

    // ---- Animations ----

    _clearFades() {
        if (this._fadeInId) {
            GLib.Source.remove(this._fadeInId);
            this._fadeInId = 0;
        }
        if (this._fadeOutId) {
            GLib.Source.remove(this._fadeOutId);
            this._fadeOutId = 0;
        }
    }

    _fadeIn(steps) {
        if (this._fadeInId) {
            GLib.Source.remove(this._fadeInId);
            this._fadeInId = 0;
        }
        if (!this._bgContainer)
            return;
        this._bgContainer.opacity = 0;
        let step = 0;
        this._fadeInId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
            step++;
            if (this._bgContainer)
                this._bgContainer.opacity = Math.round((step / steps) * 255);
            if (!this._bgContainer || step >= steps) {
                this._fadeInId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Fade the current page out, then rebuild (which fades the new one in).
    _fadeToPage() {
        this._clearFades();
        if (!this._bgContainer) {
            this._rebuildMenu();
            return;
        }
        const steps = 6;
        let step = 0;
        this._fadeOutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
            step++;
            if (this._bgContainer)
                this._bgContainer.opacity = Math.round(255 * (1 - step / steps));
            if (step < steps)
                return GLib.SOURCE_CONTINUE;
            this._fadeOutId = 0;
            this._rebuildMenu();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Popup ----

    _rebuildMenu() {
        if (!this._indicator)
            return;
        this._hideTooltip();
        this._clearFades();
        this._indicator.menu.removeAll();
        this._bgContainer = null;

        if (!this._model) {
            this._addStatusItems();
            return;
        }
        if (this._viewMode === 'daily')
            this._buildDaily();
        else
            this._buildHourly();
        this._fadeIn(6);
    }

    _addStatusItems() {
        const menu = this._indicator.menu;
        const message = {
            'loading': 'Loading weather…',
            'error': 'Couldn’t load the weather',
            'no-location': 'No location available',
        }[this._status];
        const item = new PopupMenu.PopupMenuItem(message, {reactive: false});
        menu.addMenuItem(item);

        if (this._status === 'error') {
            const detail = this._manager?.lastError?.message;
            if (detail) {
                const d = new PopupMenu.PopupMenuItem(detail, {reactive: false});
                d.label.style = 'font-size: 10px; color: #999;';
                menu.addMenuItem(d);
            }
            menu.addAction('Retry', () => this._manager?.refresh({force: true}));
        }
        if (this._status === 'no-location' || this._status === 'error')
            menu.addAction('Choose a location…', () => this.openPreferences());
    }

    // Location name, doubling as a switcher when favourites exist.
    _addHeader(subtitle) {
        const menu = this._indicator.menu;
        const name = displayName(this._model.location);
        const favorites = this._manager.favorites;
        const nameStyle = 'font-size: 18px; font-weight: bold; padding: 4px 0 0 0;';

        if (favorites.length === 0) {
            const locItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            locItem.add_child(new St.Label({
                text: name,
                style: `${nameStyle} color: #fff;`,
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            }));
            menu.addMenuItem(locItem);
        } else {
            const switcher = new PopupMenu.PopupSubMenuMenuItem(name);
            switcher.label.style = nameStyle;
            const activeId = this._manager.activeId;
            const auto = readAutoCache(this._settings);
            const choices = [
                {id: 'auto', label: auto ? `Current location (${displayName(auto.location)})` : 'Current location'},
                ...favorites.map(f => ({id: locationId(f), label: displayName(f)})),
            ];
            for (const choice of choices) {
                const item = new PopupMenu.PopupMenuItem(choice.label);
                item.setOrnament(choice.id === activeId
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                item.connect('activate', () => this._settings.set_string('active-location', choice.id));
                switcher.menu.addMenuItem(item);
            }
            menu.addMenuItem(switcher);
        }

        const subItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        subItem.add_child(new St.Label({
            text: subtitle,
            style: 'font-size: 10px; color: #bbb; padding: 0 0 4px 0;',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        menu.addMenuItem(subItem);
    }

    _dayName(date) {
        return date === this._model.today ? 'Today' : formatWeekday(date, true);
    }

    _navButton(label, onClick, props = {}) {
        const button = new St.Button({
            label,
            can_focus: true,
            track_hover: true,
            style_class: 'weather-nav-btn',
            ...props,
        });
        button.connect('clicked', onClick);
        return button;
    }

    _iconButton(iconNameStr, onClick) {
        const button = new St.Button({
            child: new St.Icon({icon_name: iconNameStr, style: 'icon-size: 14px;'}),
            can_focus: true,
            track_hover: true,
            style: 'padding: 2px 8px; border-radius: 4px;',
        });
        button.connect('clicked', onClick);
        return button;
    }

    _attachContainer(bgContainer) {
        this._bgContainer = bgContainer;
        const bgItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        bgItem.add_child(bgContainer);
        this._indicator.menu.addMenuItem(bgItem);
    }

    _buildHourly() {
        const model = this._model;
        const fmt = this._clockFormat();
        const unit = model.units.temp;
        const showUv = this._settings.get_boolean('show-uv-index');
        const showPrecip = this._settings.get_boolean('show-precipitation');
        const coloredTemps = this._settings.get_boolean('use-colored-temps');
        const coloredUv = this._settings.get_boolean('use-colored-uv');

        const forecast = this._activeDate
            ? model.hours.filter(h => h.date === this._activeDate)
            : model.hours;
        const maxPage = Math.max(0, Math.ceil(forecast.length / PER_PAGE) - 1);
        this._forecastPage = Math.min(this._forecastPage, maxPage);
        const pageItems = forecast.slice(this._forecastPage * PER_PAGE, (this._forecastPage + 1) * PER_PAGE);

        const dates = [...new Set(pageItems.map(h => h.date))];
        this._addHeader(`${dates.map(d => this._dayName(d)).join(' & ')} — Hourly`);

        const bgContainer = new St.BoxLayout({style_class: 'weather-bg-box', vertical: true, opacity: 0});

        pageItems.forEach((h, i) => {
            const row = new St.BoxLayout({
                x_expand: true,
                style: `padding: 3px 8px; spacing: 4px;${i % 2 === 0 ? ' background-color: rgba(255,255,255,0.04);' : ''}`,
            });

            row.add_child(new St.Label({
                text: h === model.hours[0] ? 'Now' : formatHour(h.time, fmt),
                style: 'font-size: 12px; font-weight: bold; min-width: 44px; color: #eee;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Icon({
                icon_name: iconName(h.code, h.isDay),
                style: 'icon-size: 16px; min-width: 20px;',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            if (showPrecip) {
                row.add_child(new St.Label({
                    text: `${h.precip}%`,
                    style: `font-size: 10px; color: ${PRECIP_COLOR}; min-width: 26px;`,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            if (showUv) {
                if (h.isDay) {
                    const color = coloredUv ? uvStyle(h.uv).color : '#aaa';
                    row.add_child(new St.Label({
                        text: `UV ${h.uv}`,
                        style: `font-size: 10px; color: ${color}; min-width: 30px;`,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                } else {
                    row.add_child(new St.Icon({
                        icon_name: 'weather-clear-night-symbolic',
                        style: 'icon-size: 12px; min-width: 30px; color: #aaa;',
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                }
            }

            const cond = WEATHER_SHORT[h.code];
            if (cond) {
                row.add_child(new St.Label({
                    text: cond,
                    style: 'font-size: 10px; color: #999; min-width: 60px;',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            row.add_child(new St.Bin({x_expand: true}));

            const color = coloredTemps ? tempColor(h.temp, unit) : '#eee';
            row.add_child(new St.Label({
                text: `${h.temp}°`,
                style: `font-size: 12px; font-weight: bold; color: ${color};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            row.reactive = true;
            row.track_hover = true;
            row.connect('enter-event', () => {
                row.opacity = 180;
            });
            row.connect('leave-event', () => {
                row.opacity = 255;
            });

            const rowItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            rowItem.add_child(row);
            bgContainer.add_child(rowItem);
        });

        const navRow = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            style: 'padding: 4px 6px 2px 6px;',
        });
        const refreshBtn = this._navButton('↻', () => {
            this._activeDate = null;
            this._manager.refresh({force: true});
        }, {x_align: Clutter.ActorAlign.START});

        const centerBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 16px;',
        });
        centerBox.add_child(this._navButton('◀', () => {
            if (this._forecastPage > 0) {
                this._forecastPage--;
                this._fadeToPage();
            }
        }));
        centerBox.add_child(new St.Label({
            text: `${this._forecastPage + 1}/${maxPage + 1}`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px;',
        }));
        centerBox.add_child(this._navButton('▶', () => {
            if (this._forecastPage < maxPage) {
                this._forecastPage++;
                this._fadeToPage();
            }
        }));

        const prefsBtn = this._navButton('⚙', () => this.openPreferences(),
            {x_align: Clutter.ActorAlign.END});

        navRow.add_child(refreshBtn);
        navRow.add_child(centerBox);
        navRow.add_child(prefsBtn);

        const toggleRow = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0px 6px 4px 6px;',
        });
        toggleRow.add_child(this._iconButton('x-office-calendar-symbolic', () => {
            this._activeDate = null;
            this._viewMode = 'daily';
            this._fadeToPage();
        }));

        const bottomBox = new St.BoxLayout({vertical: true, x_expand: true});
        bottomBox.add_child(navRow);
        bottomBox.add_child(toggleRow);

        const navItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        navItem.add_child(bottomBox);
        bgContainer.add_child(new PopupMenu.PopupSeparatorMenuItem());
        bgContainer.add_child(navItem);

        this._attachContainer(bgContainer);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildDaily() {
        const model = this._model;
        const days = model.days;
        const unit = model.units.temp;
        const coloredTemps = this._settings.get_boolean('use-colored-temps');

        let subtitle = '7-Day Forecast';
        if (days.length >= 2)
            subtitle = `${formatShortDate(days[0].date)} — ${formatShortDate(days[days.length - 1].date)}`;
        this._addHeader(subtitle);

        if (days.length === 0)
            return;

        const weekMin = Math.min(...days.map(d => d.low));
        const weekMax = Math.max(...days.map(d => d.high));
        const weekRange = weekMax - weekMin || 1;
        const barTotalPx = 100;
        const colorFor = t => (coloredTemps ? tempColor(t, unit) : '#bbb');

        const bgContainer = new St.BoxLayout({style_class: 'weather-bg-box', vertical: true, opacity: 0});

        days.forEach((day, i) => {
            const row = new St.BoxLayout({
                x_expand: true,
                style: `padding: 4px 10px; spacing: 6px;${i % 2 === 0 ? ' background-color: rgba(255,255,255,0.04);' : ''}`,
            });

            row.add_child(new St.Label({
                text: day.isToday ? 'Today' : formatWeekday(day.date),
                style: 'font-size: 12px; font-weight: bold; min-width: 36px; color: #eee;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Icon({
                icon_name: iconName(day.code, true),
                style: 'icon-size: 16px; min-width: 20px;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                text: `${day.precip}%`,
                style: `font-size: 10px; color: ${PRECIP_COLOR}; min-width: 26px;`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                text: `${day.low}°`,
                style: 'font-size: 11px; color: #999; min-width: 24px;',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            // Low→high bar positioned within the week's range, with a colour gradient.
            const loPct = ((day.low - weekMin) / weekRange) * 100;
            const hiPct = ((day.high - weekMin) / weekRange) * 100;
            const leftPad = Math.max(0, Math.round(loPct / 100 * barTotalPx));
            const rightPad = Math.max(0, barTotalPx - leftPad - Math.max(Math.round((hiPct - loPct) / 100 * barTotalPx), 6));

            const track = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'min-height: 4px; border-radius: 2px; background-color: rgba(255,255,255,0.12);',
            });
            if (leftPad > 0)
                track.add_child(new St.Bin({style: `min-width: ${leftPad}px;`}));

            const lowColor = colorFor(day.low);
            const highColor = colorFor(day.high);
            const channel = (hex, n) => parseInt(hex.slice(1 + n * 2, 3 + n * 2), 16);
            const segments = 8;
            const totalBarPx = barTotalPx - leftPad - rightPad;
            const segW = Math.max(Math.round(totalBarPx / segments), 2);
            for (let s = 0; s < segments; s++) {
                const t = s / (segments - 1);
                const [r, g, b] = [0, 1, 2].map(n =>
                    Math.round(channel(lowColor, n) + (channel(highColor, n) - channel(lowColor, n)) * t));
                const w = s < segments - 1 ? segW : Math.max(totalBarPx - segW * (segments - 1), 2);
                const radius = s === 0 ? ' border-radius: 2px 0 0 2px;'
                    : s === segments - 1 ? ' border-radius: 0 2px 2px 0;' : '';
                track.add_child(new St.Bin({
                    style: `min-width: ${w}px; min-height: 4px; background-color: rgb(${r},${g},${b});${radius}`,
                }));
            }
            if (rightPad > 0)
                track.add_child(new St.Bin({style: `min-width: ${rightPad}px;`}));
            row.add_child(track);

            row.add_child(new St.Label({
                text: `${day.high}°`,
                style: 'font-size: 11px; font-weight: bold; color: #eee; min-width: 24px;',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            row.reactive = true;
            row.track_hover = true;
            row.connect('enter-event', () => {
                row.opacity = 180;
                this._showTooltip(row, day);
            });
            row.connect('leave-event', () => {
                row.opacity = 255;
                this._hideTooltip();
            });
            row.connect('button-release-event', () => {
                this._activeDate = day.date;
                this._forecastPage = 0;
                this._viewMode = 'hourly';
                this._fadeToPage();
                return Clutter.EVENT_STOP;
            });

            const rowItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            rowItem.add_child(row);
            bgContainer.add_child(rowItem);
        });

        const toggleRow = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 2px 6px 4px 6px;',
        });
        toggleRow.add_child(this._iconButton('preferences-system-time-symbolic', () => {
            this._activeDate = null;
            this._forecastPage = 0;
            this._viewMode = 'hourly';
            this._fadeToPage();
        }));
        const toggleItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        toggleItem.add_child(toggleRow);
        bgContainer.add_child(new PopupMenu.PopupSeparatorMenuItem());
        bgContainer.add_child(toggleItem);

        this._attachContainer(bgContainer);
    }

    // ---- Daily tooltip ----

    _daySummary(day) {
        const {temp: unit, wind: windUnit} = this._model.units;
        let s = weatherDesc(day.code);
        if (day.precip > 20)
            s += `. ${day.precip}% chance of rain`;
        else if (day.precip > 0)
            s += ` with a ${day.precip}% chance of rain`;
        if (windLabel(day.windMax, windUnit) !== 'Calm' && windLabel(day.windMax, windUnit) !== 'Light')
            s += `. ${windLabel(day.windMax, windUnit)} winds ${windDir(day.windDir)} ${day.windMax} ${windUnit}`;
        s += `. High ${day.high}${unit}, low ${day.low}${unit}`;
        return s;
    }

    _hideTooltip() {
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    _showTooltip(row, day) {
        this._hideTooltip();
        const {temp: unit, wind: windUnit} = this._model.units;
        const fmt = this._clockFormat();
        const hours = this._model.hours.filter(h => h.date === day.date);
        const avg = key => Math.round(hours.reduce((s, h) => s + h[key], 0) / hours.length);
        const max = key => Math.max(...hours.map(h => h[key]));

        const periodStats = ph => {
            if (ph.length === 0)
                return null;
            const codes = {};
            for (const h of ph)
                codes[h.code] = (codes[h.code] || 0) + 1;
            const dominant = parseInt(Object.entries(codes).sort((a, b) => b[1] - a[1])[0][0]);
            return {
                temp: Math.round(ph.reduce((s, h) => s + h.temp, 0) / ph.length),
                precip: Math.max(...ph.map(h => h.precip)),
                code: dominant,
                isDay: ph[0].isDay,
            };
        };

        const box = new St.BoxLayout({
            vertical: true,
            style: 'padding: 10px 12px; border-radius: 8px; background-color: rgba(30, 30, 30, 0.95); border: 1px solid rgba(255,255,255,0.15); spacing: 3px; width: 220px;',
        });

        const topRow = new St.BoxLayout({style: 'spacing: 8px; padding: 0 0 2px 0;'});
        topRow.add_child(new St.Icon({
            icon_name: iconName(day.code, true),
            style: 'icon-size: 28px; color: #eee;',
        }));
        topRow.add_child(new St.Label({
            text: weatherDesc(day.code),
            style: 'font-size: 14px; font-weight: bold; color: #fff;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(topRow);

        const summaryLabel = new St.Label({
            text: this._daySummary(day),
            style: 'font-size: 11px; color: #bbb; padding: 0 0 6px 0;',
            x_expand: true,
        });
        summaryLabel.clutter_text.line_wrap = true;
        summaryLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        box.add_child(summaryLabel);

        const hiloRow = new St.BoxLayout({style: 'spacing: 12px; padding: 2px 0;'});
        hiloRow.add_child(new St.Label({text: `H: ${day.high}${unit}`, style: 'font-size: 12px; font-weight: bold; color: #eee;'}));
        hiloRow.add_child(new St.Label({text: `L: ${day.low}${unit}`, style: 'font-size: 12px; color: #999;'}));
        if (hours.length > 0)
            hiloRow.add_child(new St.Label({text: `Feels ${avg('feels')}${unit}`, style: 'font-size: 12px; color: #aaa;'}));
        box.add_child(hiloRow);

        box.add_child(new St.Label({text: ' ', style: 'font-size: 2px;'}));

        const detailRow = (label, value, color = '#aaa') => {
            const r = new St.BoxLayout({style: 'spacing: 4px;'});
            r.add_child(new St.Label({text: label, style: 'font-size: 11px; color: #777; min-width: 72px;'}));
            r.add_child(new St.Label({text: value, style: `font-size: 11px; color: ${color};`}));
            return r;
        };

        if (hours.length > 0) {
            box.add_child(detailRow('Humidity', `${avg('humidity')}%`));
            const maxUv = max('uv');
            if (maxUv > 0) {
                const uv = uvStyle(maxUv);
                box.add_child(detailRow('UV Index', `${maxUv} ${uv.label}`, uv.color));
            }
            box.add_child(detailRow('Wind', `${max('wind')} ${windUnit}`));
        }
        box.add_child(detailRow('Precip', `${day.precip}%`, PRECIP_COLOR));
        if (day.sunrise && day.sunset)
            box.add_child(detailRow('Daylight', `${formatClock(day.sunrise, fmt)}–${formatClock(day.sunset, fmt)}`, '#888'));

        box.add_child(new St.Label({text: ' ', style: 'font-size: 4px;'}));

        const periods = [
            {label: 'Morning', stats: periodStats(hours.filter(h => h.hour >= 6 && h.hour < 12))},
            {label: 'Afternoon', stats: periodStats(hours.filter(h => h.hour >= 12 && h.hour < 18))},
            {label: 'Evening', stats: periodStats(hours.filter(h => h.hour >= 18 && h.hour < 21))},
            {label: 'Night', stats: periodStats(hours.filter(h => h.hour >= 21 || h.hour < 6))},
        ].filter(p => p.stats);
        for (const p of periods) {
            const pr = new St.BoxLayout({style: 'spacing: 4px;'});
            pr.add_child(new St.Icon({
                icon_name: iconName(p.stats.code, p.stats.isDay),
                style: 'icon-size: 14px; min-width: 18px; color: #ccc;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            pr.add_child(new St.Label({text: p.label, style: 'font-size: 11px; font-weight: bold; color: #ddd; min-width: 68px;'}));
            pr.add_child(new St.Label({text: `${p.stats.temp}${unit}`, style: 'font-size: 11px; color: #eee;'}));
            pr.add_child(new St.Label({text: `${p.stats.precip}%`, style: `font-size: 10px; color: ${PRECIP_COLOR};`}));
            box.add_child(pr);
        }

        Main.uiGroup.add_child(box);
        this._tooltip = box;

        // Not allocated yet, so measure with preferred sizes.
        const [, tipW] = box.get_preferred_width(-1);
        const [, tipH] = box.get_preferred_height(tipW);
        const [, rowY] = row.get_transformed_position();
        const [, rowH] = row.get_transformed_size();
        const [menuX] = this._indicator.menu.actor.get_transformed_position();
        const [menuW] = this._indicator.menu.actor.get_transformed_size();
        const stageW = global.stage.width;
        const stageH = global.stage.height;
        if (![rowY, rowH, menuX, menuW].every(Number.isFinite)) {
            // Row not laid out yet (e.g. hovered during a rebuild).
            this._hideTooltip();
            return;
        }

        let tipX;
        if (stageW - (menuX + menuW) >= tipW + 8)
            tipX = menuX + menuW + 6;
        else if (menuX >= tipW + 8)
            tipX = menuX - tipW - 6;
        else
            tipX = Math.max(4, stageW - tipW - 4);

        const tipY = Math.max(4, Math.min(rowY + rowH / 2 - tipH / 2, stageH - tipH - 8));
        box.set_position(Math.round(tipX), Math.round(tipY));
    }
}
