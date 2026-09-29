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
//  lib/conditions.js      weather codes → icons/labels, colour scales.
//  ui/chart.js            hourly chart (St.DrawingArea + Cairo).
//  ui/dayTooltip.js       details card for a hovered day.
//  extension.js           this file: panel indicator + popup, driven by manager events.
//
//  Popup layout
//  ------------
//  location switcher (submenu)
//  current conditions
//  ───────────────────────
//  [ Hourly | Chart | Daily ]      tabs (remembered in `popup-view`)
//  subtitle / day filter chip
//  view (table, chart or days)     rebuilt with a cross-fade on page/view change
//  ↻  Updated 14:05   ◀ 1/21 ▶  ⚙  footer

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    aqiStyle, formatAmount, iconName, tempColor, uvStyle, weatherDesc, windArrow,
} from './lib/conditions.js';
import {displayName, locationId, readAutoCache} from './lib/location.js';
import {
    createInterfaceSettings, formatClock, formatHour, formatShortDate, formatUnixClock,
    formatWeekday, resolveClockFormat,
} from './lib/timeFormat.js';
import {WeatherManager} from './lib/weatherManager.js';
import {SLOTS, buildChart, vertical} from './ui/chart.js';
import {buildDayTooltip} from './ui/dayTooltip.js';

const FADE_OUT_MS = 80;
const FADE_IN_MS = 140;
const RANGE_BAR_EM = 8; // matches .cw-range-track width

const VIEWS = [
    {id: 'hourly', label: 'Hourly'},
    {id: 'chart', label: 'Chart'},
    {id: 'daily', label: 'Daily'},
];

// Extension lifecycle: enable() creates everything, disable() must destroy/disconnect all.
export default class CrispsWeatherExtension extends Extension {
    enable() {
        this._model = null;
        this._status = 'loading'; // 'loading' | 'ok' | 'error' | 'no-location'
        this._date = null; // day shown in the hourly table and chart; null = today
        this._tooltip = null;
        this._tabs = null;
        this._viewHolder = null;
        this._footerBox = null;

        this._settings = this.getSettings();
        this._interfaceSettings = createInterfaceSettings();
        this._view = this._settings.get_string('popup-view');
        this._hourView = this._view === 'chart' ? 'chart' : 'hourly';

        const rebuild = () => this._rebuildMenu();
        this._settings.connectObject(
            'changed::panel-display', () => this._applyPanel(),
            'changed::temperature-position', () => this._applyPanel(),
            'changed::popup-view', () => this._onViewSetting(),
            'changed::use-colored-temps', rebuild,
            'changed::use-colored-uv', rebuild,
            'changed::show-uv-index', rebuild,
            'changed::show-precipitation', rebuild,
            'changed::show-rain-amount', rebuild,
            'changed::show-wind', rebuild,
            'changed::show-feels-like', rebuild,
            'changed::show-humidity', rebuild,
            'changed::show-air-quality', rebuild,
            'changed::show-weather-icons', rebuild,
            'changed::text-scale', rebuild,
            'changed::clock-format', rebuild,
            'changed::favorites', rebuild,
            'changed::active-location', rebuild,
            this);
        this._interfaceSettings.connectObject('changed::clock-format', rebuild, this);
        // Temperature/UV colours differ between the dark and light shell styles.
        St.Settings.get().connectObject('notify::color-scheme', rebuild, this);

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._indicator.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open) {
                this._manager?.refresh();
                this._updateLocalTime();
                this._fillFooter();
            } else {
                this._hideTooltip();
            }
        }, this);

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'system-status-icon'});
        this._label = new St.Label({
            text: '--°',
            style_class: 'cw-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._box);
        this._applyPanel();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._manager = new WeatherManager(this._settings);
        this._manager.connect('loading', () => {
            // Keep what's on screen (data, or an error/no-location message);
            // the footer says "Updating…".
            if (this._model || this._status !== 'loading')
                this._fillFooter();
            else
                this._rebuildMenu();
        });
        this._manager.connect('updated', (_m, model) => this._onUpdated(model));
        this._manager.connect('error', () => {
            this._status = 'error';
            // With data on screen, only the footer changes (it shows the failure).
            if (this._model)
                this._fillFooter();
            else
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
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._interfaceSettings?.disconnectObject(this);
        this._interfaceSettings = null;
        St.Settings.get().disconnectObject(this);
        this._hideTooltip();
        this._indicator?.menu.disconnectObject(this);
        // Destroys the menu and everything in it, and the panel box.
        this._indicator?.destroy();
        this._indicator = null;
        this._box = null;
        this._icon = null;
        this._label = null;
        this._tabs = null;
        this._viewHolder = null;
        this._footerBox = null;
        this._locationInfo = null;
        this._model = null;
    }

    _onUpdated(model) {
        const moved = !this._model || locationId(this._model.location) !== locationId(model.location);
        this._model = model;
        this._status = 'ok';
        if (moved)
            this._date = null;
        this._applyPanel();
        this._rebuildMenu();
    }

    _clockFormat() {
        return resolveClockFormat(this._settings.get_string('clock-format'), this._interfaceSettings);
    }

    _scaleStyle() {
        return `font-size: ${this._settings.get_uint('text-scale') / 100}em;`;
    }

    _variant() {
        return Main.getStyleVariant?.() === 'light' ? 'light' : 'dark';
    }

    _tempColor(t) {
        return this._settings.get_boolean('use-colored-temps')
            ? tempColor(t, this._model.units.temp, this._variant()) : null;
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

    // ---- Popup skeleton ----

    _rebuildMenu() {
        if (!this._indicator)
            return;
        this._hideTooltip();
        const menu = this._indicator.menu;
        menu.removeAll();
        // Sizes in the stylesheet are in em, so this scales the whole popup.
        menu.box.style = this._scaleStyle();
        this._tabs = null;
        this._viewHolder = null;
        this._locationInfo = null;

        if (this._model) {
            this._addLocationSwitcher();
            this._addCurrent();
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const body = new St.BoxLayout({style_class: 'cw-content', x_expand: true, ...vertical()});
        if (this._model) {
            body.add_child(this._buildTabs());
            this._viewHolder = new St.Bin({x_expand: true, x_align: Clutter.ActorAlign.FILL});
            body.add_child(this._viewHolder);
            this._fillView();
        } else {
            body.add_child(this._buildStatus());
        }
        menu.addMenuItem(this._contentItem(body));

        this._footerBox = new St.BoxLayout({style_class: 'cw-footer', x_expand: true});
        menu.addMenuItem(this._contentItem(this._footerBox));
        this._fillFooter();
    }

    // A non-interactive menu item holding custom content.
    _contentItem(child) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cw-item'});
        item.add_child(child);
        return item;
    }

    _iconButton(icon, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'cw-icon-btn',
            child: new St.Icon({icon_name: icon}),
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    // ---- Header ----

    _addLocationSwitcher() {
        const activeId = this._manager.activeId;
        const switcher = new PopupMenu.PopupSubMenuMenuItem(displayName(this._model.location), true);
        switcher.label.add_style_class_name('cw-location');
        switcher.icon.icon_name = activeId === 'auto' ? 'find-location-symbolic' : 'starred-symbolic';

        const auto = readAutoCache(this._settings);
        const choices = [
            {id: 'auto', label: auto ? `Current location (${displayName(auto.location)})` : 'Current location'},
            ...this._manager.favorites.map(f => ({id: locationId(f), label: displayName(f)})),
        ];
        for (const choice of choices) {
            const item = new PopupMenu.PopupMenuItem(choice.label);
            item.setOrnament(choice.id === activeId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._settings.set_string('active-location', choice.id));
            switcher.menu.addMenuItem(item);
        }
        switcher.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        switcher.menu.addAction('Add or edit locations…', () => this.openPreferences());
        this._indicator.menu.addMenuItem(switcher);
        this._addLocationInfo();
    }

    // "50.09° N, 14.42° E  ·  235 m  ·  CEST  ·  local time 14:32"
    _addLocationInfo() {
        const {location, elevation, units, timezone, timezoneAbbr} = this._model;
        const coord = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
        const parts = [`${coord(location.lat, 'N', 'S')}, ${coord(location.lon, 'E', 'W')}`];
        if (elevation !== null)
            parts.push(units.temp === '°F' ? `${Math.round(elevation * 3.281)} ft` : `${elevation} m`);
        parts.push(timezoneAbbr || timezone);
        this._locationInfo = new St.Label({text: parts.join('  ·  '), style_class: 'cw-location-info cw-dim'});
        this._locationInfoBase = this._locationInfo.text;
        this._updateLocalTime();
        this._indicator.menu.addMenuItem(this._contentItem(this._locationInfo));
    }

    // Append the location's current time when it differs from the system's.
    _updateLocalTime() {
        if (!this._locationInfo || !this._model)
            return;
        let text = this._locationInfoBase;
        const tz = GLib.TimeZone.new_identifier?.(this._model.timezone);
        const here = GLib.DateTime.new_now_local();
        if (tz) {
            const there = GLib.DateTime.new_now(tz);
            if (there.get_utc_offset() !== here.get_utc_offset()) {
                const fmt = this._clockFormat() === '12h' ? '%-l:%M %p' : '%H:%M';
                text += `  ·  local time ${there.format(fmt).trim()}`;
            }
        }
        this._locationInfo.text = text;
    }

    _addCurrent() {
        const {current, units, hours, days, nowIndex} = this._model;
        const today = days.find(d => d.isToday) ?? days[0];
        const now = hours[nowIndex];
        const variant = this._variant();

        const box = new St.BoxLayout({style_class: 'cw-current', x_expand: true});
        box.add_child(new St.Icon({
            icon_name: iconName(current.code, current.isDay),
            style_class: 'cw-current-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const temp = new St.Label({
            text: `${current.temp}°`,
            style_class: 'cw-current-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const color = this._tempColor(current.temp);
        if (color)
            temp.style = `color: ${color};`;
        box.add_child(temp);

        const text = new St.BoxLayout({style_class: 'cw-current-text', y_align: Clutter.ActorAlign.CENTER, ...vertical()});
        const addLine = (line, styleClass = 'cw-current-detail cw-dim', style = null) => {
            const label = new St.Label({text: line, style_class: styleClass});
            if (style)
                label.style = style;
            text.add_child(label);
        };
        addLine(weatherDesc(current.code), 'cw-current-desc');
        const detail = [];
        if (current.feels !== null)
            detail.push(`Feels like ${current.feels}°`);
        if (today)
            detail.push(`H ${today.high}°  L ${today.low}°`);
        addLine(detail.join('  ·  '));
        if (today?.sunrise && today?.sunset) {
            const fmt = this._clockFormat();
            addLine(`Sunrise ${formatClock(today.sunrise, fmt)}  ·  Sunset ${formatClock(today.sunset, fmt)}`);
        }
        if (now) {
            const rain = now.rain > 0 ? `Rain ${now.precip}%, ${formatAmount(now.rain, units.rain)} ${units.rain}` : `Rain ${now.precip}%`;
            const extra = [rain, `Wind ${now.wind} ${units.wind} ${windArrow(now.windDir)}`];
            if (this._settings.get_boolean('show-uv-index') && now.isDay)
                extra.push(`UV ${now.uv}`);
            addLine(extra.join('  ·  '));
        }
        const soon = this._rainSoonText();
        if (soon)
            addLine(soon, 'cw-current-detail cw-precip');
        if (this._settings.get_boolean('show-air-quality') && current.aqi !== null) {
            const aqi = aqiStyle(current.aqi, variant);
            let line = `Air quality: ${aqi.label} (${current.aqi})`;
            if (current.pollen.length > 0)
                line += `  ·  ${current.pollen[0].name} pollen ${current.pollen[0].value}/m³`;
            addLine(line, 'cw-current-detail', `color: ${aqi.color};`);
        }
        box.add_child(text);

        this._indicator.menu.addMenuItem(this._contentItem(box));
    }

    _rainSoonText() {
        const soon = this._model.rainSoon;
        if (!soon)
            return null;
        const {temp, units} = {temp: this._model.current.temp, units: this._model.units};
        const kind = temp <= (units.temp === '°F' ? 32 : 0) ? 'Snow' : 'Rain';
        if (soon.state === 'starting')
            return `${kind} likely in ~${soon.minutes} min`;
        if (soon.state === 'stopping')
            return `${kind} easing in ~${soon.minutes} min`;
        return `${kind} for the next ${soon.minutes >= 120 ? '2 hours' : `${soon.minutes} min`}`;
    }

    // ---- Tabs and view switching ----

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'cw-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._tabs = new Map();
        for (const view of VIEWS) {
            const tab = new St.Button({
                label: view.label,
                style_class: 'cw-tab',
                can_focus: true,
                track_hover: true,
                checked: view.id === this._view,
            });
            tab.connect('clicked', () => this._settings.set_string('popup-view', view.id));
            tabs.add_child(tab);
            this._tabs.set(view.id, tab);
        }
        return tabs;
    }

    _onViewSetting() {
        const view = this._settings.get_string('popup-view');
        if (view === this._view)
            return;
        this._view = view;
        if (view !== 'daily')
            this._hourView = view;
        for (const [id, tab] of this._tabs ?? [])
            tab.checked = id === view;
        this._transition();
    }

    // Apply `change` to the view state, then cross-fade the view area (and the
    // footer's pager) to it. State changes immediately, so a transition that
    // interrupts another never loses the first one's change.
    _transition(change = null) {
        change?.();
        const old = this._viewHolder?.get_child();
        if (!old) {
            this._fillView();
            this._fillFooter();
            return;
        }
        this._hideTooltip();
        old.remove_all_transitions();
        old.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._fillView();
                this._fillFooter();
                const next = this._viewHolder?.get_child();
                if (!next)
                    return;
                next.opacity = 0;
                next.ease({opacity: 255, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            },
        });
    }

    // Open the hourly table or chart (whichever was used last) on one day.
    _showDay(date) {
        this._date = date;
        this._settings.set_string('popup-view', this._hourView);
    }

    // ---- Day pages (hourly table and chart) ----

    _dates() {
        return this._model.days.map(d => d.date);
    }

    // The day shown; falls back to today when unset or no longer forecast.
    _shownDate() {
        return this._dates().includes(this._date) ? this._date : this._model.today;
    }

    _pageCount() {
        return this._view === 'daily' ? 1 : this._dates().length;
    }

    _pageIndex() {
        return Math.max(0, this._dates().indexOf(this._shownDate()));
    }

    _setPage(index) {
        const date = this._dates()[index];
        if (!date || date === this._shownDate())
            return;
        this._transition(() => {
            this._date = date;
        });
    }

    _fillView() {
        if (!this._viewHolder || !this._model)
            return;
        const box = new St.BoxLayout({x_expand: true, ...vertical()});
        if (this._view === 'daily')
            this._buildDaily(box);
        else if (this._view === 'chart')
            this._buildChartView(box);
        else
            this._buildHourly(box);
        this._viewHolder.set_child(box);
    }

    _dayName(date, long = true) {
        if (date === this._model.today)
            return 'Today';
        return formatWeekday(date, long);
    }

    _addSubtitle(box, text) {
        box.add_child(new St.Label({text, style_class: 'cw-subtitle', x_align: Clutter.ActorAlign.CENTER}));
    }

    _daySubtitle(date) {
        return `${this._dayName(date)}  ·  ${formatShortDate(date)}`;
    }

    // Which optional data series are on (table columns and chart panels).
    _series() {
        const on = key => this._settings.get_boolean(key);
        return {
            precip: on('show-precipitation'),
            rain: on('show-rain-amount'),
            wind: on('show-wind'),
            uv: on('show-uv-index'),
            feels: on('show-feels-like'),
            humidity: on('show-humidity'),
            aqi: on('show-air-quality') && this._model.hours.some(h => h.aqi !== null),
        };
    }

    // ---- Views ----

    _buildHourly(box) {
        const model = this._model;
        const {units} = model;
        const fmt = this._clockFormat();
        const variant = this._variant();
        const series = this._series();
        const coloredUv = this._settings.get_boolean('use-colored-uv');
        const nowTime = model.hours[model.nowIndex]?.time;
        const date = this._shownDate();
        this._addSubtitle(box, this._daySubtitle(date));

        // Columns: header text, style class, and cell text/colour for an hour.
        const columns = [
            {header: '', cls: 'cw-hour-time', text: h => (h.time === nowTime ? 'Now' : formatHour(h.time, fmt))},
        ];
        if (this._settings.get_boolean('show-weather-icons'))
            columns.push({icon: true});
        if (series.precip)
            columns.push({header: 'Rain', cls: 'cw-precip', text: h => `${h.precip}%`});
        if (series.rain) {
            columns.push({
                header: units.rain,
                cls: 'cw-amount',
                text: h => formatAmount(h.rain, units.rain),
                dim: h => h.rain <= 0,
            });
        }
        if (series.wind) {
            columns.push({header: units.wind, cls: 'cw-wind', text: h => `${h.wind} ${windArrow(h.windDir)}`});
        }
        if (series.uv) {
            columns.push({
                header: 'UV',
                cls: 'cw-uv',
                text: h => String(h.uv),
                color: h => (coloredUv && h.uv > 0 ? uvStyle(h.uv, variant).color : null),
                dim: h => !coloredUv || h.uv <= 0,
            });
        }
        if (series.humidity)
            columns.push({header: 'Hum.', cls: 'cw-humidity', text: h => `${h.humidity}%`, dim: () => true});
        if (series.aqi) {
            columns.push({
                header: 'AQI',
                cls: 'cw-aqi',
                text: h => (h.aqi === null ? '–' : String(h.aqi)),
                color: h => (h.aqi === null ? null : aqiStyle(h.aqi, variant).color),
            });
        }
        if (series.feels)
            columns.push({header: 'Feels', cls: 'cw-feels', text: h => `${h.feels}°`, dim: () => true});
        columns.push({header: '', cls: 'cw-temp', text: h => `${h.temp}°`, color: h => this._tempColor(h.temp)});

        // Every column gets the same width (homogeneous row), so the table is
        // evenly spaced and the header lines up; time hugs the left edge and
        // temperature the right one.
        const alignOf = col => {
            if (col.cls === 'cw-hour-time')
                return Clutter.ActorAlign.START;
            if (col.cls === 'cw-temp')
                return Clutter.ActorAlign.END;
            return Clutter.ActorAlign.CENTER;
        };
        const makeRow = (hour, i) => {
            const row = new St.BoxLayout({style_class: 'cw-row cw-table-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            if (hour && i % 2 === 0)
                row.add_style_class_name('cw-row-alt');
            if (!hour)
                row.add_style_class_name('cw-table-header');
            for (const col of columns) {
                const cell = {x_expand: true, x_align: col.icon ? Clutter.ActorAlign.CENTER : alignOf(col), y_align: Clutter.ActorAlign.CENTER};
                if (col.icon) {
                    row.add_child(hour
                        ? new St.Icon({
                            icon_name: iconName(hour.code, hour.isDay),
                            style_class: 'cw-row-icon',
                            accessible_name: weatherDesc(hour.code),
                            ...cell,
                        })
                        : new St.Widget({style_class: 'cw-row-icon', ...cell}));
                    continue;
                }
                const label = new St.Label({
                    text: hour ? col.text(hour) : col.header,
                    style_class: `${col.cls} cw-cell`,
                    ...cell,
                });
                const color = hour && col.color?.(hour);
                if (color)
                    label.style = `color: ${color};`;
                else if (hour && col.dim?.(hour))
                    label.add_style_class_name('cw-dim');
                row.add_child(label);
            }
            return row;
        };

        box.add_child(makeRow(null));
        const rows = new St.BoxLayout({x_expand: true, ...vertical()});
        model.hours
            .filter(h => h.date === date && !h.past)
            .forEach((h, i) => rows.add_child(makeRow(h, i)));
        // A day is up to 24 rows; scroll within the page instead of growing the popup.
        const scroll = new St.ScrollView({
            style_class: 'cw-table-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scroll.child = rows;
        box.add_child(scroll);
    }

    _describeHour(h) {
        const model = this._model;
        const {units} = model;
        const series = this._series();
        const nowTime = model.hours[model.nowIndex]?.time;
        const parts = [
            h.time === nowTime ? 'Now' : formatHour(h.time, this._clockFormat()),
            series.feels ? `${h.temp}${units.temp} (feels ${h.feels}°)` : `${h.temp}${units.temp}`,
            weatherDesc(h.code),
        ];
        if (series.precip || series.rain) {
            const rain = [];
            if (series.precip)
                rain.push(`${h.precip}%`);
            if (series.rain && h.rain > 0)
                rain.push(`${formatAmount(h.rain, units.rain)} ${units.rain}`);
            parts.push(`rain ${rain.join(', ')}`);
        }
        if (series.wind)
            parts.push(`${h.wind} ${units.wind} ${windArrow(h.windDir)}`);
        if (series.uv && h.isDay)
            parts.push(`UV ${h.uv}`);
        if (series.humidity)
            parts.push(`${h.humidity}% humidity`);
        if (series.aqi && h.aqi !== null)
            parts.push(`AQI ${h.aqi}`);
        return parts.join('  ·  ');
    }

    _buildChartView(box) {
        const model = this._model;
        const date = this._shownDate();
        this._addSubtitle(box, this._daySubtitle(date));
        // One calendar day, each hour in its own slot (today's past hours included).
        const slots = new Array(SLOTS).fill(null);
        for (const h of model.hours) {
            if (h.date === date)
                slots[h.hour] = h;
        }
        if (!slots.some(Boolean))
            return;

        const series = this._series();
        box.add_child(buildChart({
            slots,
            series,
            units: model.units,
            nowTime: model.hours[model.nowIndex]?.time,
            clockFormat: this._clockFormat(),
            colored: this._settings.get_boolean('use-colored-temps'),
            coloredUv: this._settings.get_boolean('use-colored-uv'),
            variant: this._variant(),
            describe: h => (h ? this._describeHour(h) : ''),
        }));
    }

    _buildDaily(box) {
        const model = this._model;
        const days = model.days;
        if (days.length >= 2)
            this._addSubtitle(box, `${formatShortDate(days[0].date)} – ${formatShortDate(days[days.length - 1].date)}`);
        if (days.length === 0)
            return;

        const showRain = this._settings.get_boolean('show-rain-amount');
        const weekMin = Math.min(...days.map(d => d.low));
        const weekMax = Math.max(...days.map(d => d.high));
        const weekRange = weekMax - weekMin || 1;

        days.forEach((day, i) => {
            const row = new St.BoxLayout({style_class: 'cw-day-box', x_expand: true});
            row.add_child(new St.Label({
                text: this._dayName(day.date, false),
                style_class: 'cw-day-name',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const icons = new St.BoxLayout({style_class: 'cw-day-icons', y_align: Clutter.ActorAlign.CENTER});
            icons.add_child(new St.Icon({icon_name: iconName(day.code), style_class: 'cw-row-icon'}));
            if (day.code2 !== null && iconName(day.code2) !== iconName(day.code)) {
                icons.add_child(new St.Icon({
                    icon_name: iconName(day.code2),
                    style_class: 'cw-day-icon2 cw-dim',
                    y_align: Clutter.ActorAlign.END,
                }));
            }
            row.add_child(icons);

            row.add_child(new St.Label({
                text: `${day.precip}%`,
                style_class: 'cw-precip',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            if (showRain) {
                const amount = new St.Label({
                    text: day.rain > 0 ? `${formatAmount(day.rain, model.units.rain)} ${model.units.rain}` : '',
                    style_class: 'cw-amount cw-day-amount',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(amount);
            }
            row.add_child(new St.Widget({x_expand: true}));
            row.add_child(new St.Label({
                text: `${day.low}°`,
                style_class: 'cw-low',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(this._rangeBar(day, weekMin, weekRange));
            row.add_child(new St.Label({
                text: `${day.high}°`,
                style_class: 'cw-high',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const button = new St.Button({
                child: row,
                style_class: 'cw-day',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                accessible_name: `${this._dayName(day.date)}: ${weatherDesc(day.code)}, ${day.low}° to ${day.high}°`,
            });
            if (i % 2 === 0)
                button.add_style_class_name('cw-row-alt');
            button.connect('clicked', () => this._showDay(day.date));
            // Details on hover, and on keyboard focus.
            button.connect('notify::hover', () => {
                if (button.hover)
                    this._showTooltip(button, day);
                else if (!button.has_key_focus())
                    this._hideTooltip();
            });
            button.connect('key-focus-in', () => this._showTooltip(button, day));
            button.connect('key-focus-out', () => this._hideTooltip());
            box.add_child(button);
        });
    }

    // Low→high bar placed within the week's temperature range.
    _rangeBar(day, weekMin, weekRange) {
        const em = v => `${v.toFixed(2)}em`;
        const width = Math.max(0.5, (day.high - day.low) / weekRange * RANGE_BAR_EM);
        const left = Math.min((day.low - weekMin) / weekRange * RANGE_BAR_EM, RANGE_BAR_EM - width);
        const track = new St.BoxLayout({style_class: 'cw-range-track', y_align: Clutter.ActorAlign.CENTER});
        track.add_child(new St.Widget({style: `width: ${em(left)};`}));
        const bar = new St.Widget({style_class: 'cw-range-bar'});
        const lo = this._tempColor(day.low);
        const hi = this._tempColor(day.high);
        bar.style = lo
            ? `width: ${em(width)}; background-gradient-direction: horizontal; ` +
              `background-gradient-start: ${lo}; background-gradient-end: ${hi};`
            : `width: ${em(width)};`;
        if (!lo)
            bar.add_style_class_name('cw-range-bar-plain');
        track.add_child(bar);
        return track;
    }

    // ---- Status (no data) ----

    _buildStatus() {
        const box = new St.BoxLayout({style_class: 'cw-status', x_expand: true, ...vertical()});
        const title = {
            'loading': 'Loading weather…',
            'error': 'Couldn’t load the weather',
            'no-location': 'No location available',
        }[this._status];
        box.add_child(new St.Label({text: title, style_class: 'cw-status-title', x_align: Clutter.ActorAlign.CENTER}));

        let detail = null;
        if (this._status === 'error')
            detail = this._manager?.lastError?.message;
        else if (this._status === 'no-location')
            detail = 'Turn on Location Services, allow IP lookup, or add a location.';
        if (detail) {
            const label = new St.Label({text: detail, style_class: 'cw-status-detail', x_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.line_wrap = true;
            box.add_child(label);
        }

        const buttons = new St.BoxLayout({style_class: 'cw-status-buttons', x_align: Clutter.ActorAlign.CENTER});
        const addButton = (text, onClick) => {
            const button = new St.Button({label: text, style_class: 'button', can_focus: true, track_hover: true});
            button.connect('clicked', onClick);
            buttons.add_child(button);
        };
        if (this._status === 'error')
            addButton('Retry', () => this._manager?.refresh({force: true}));
        if (this._status !== 'loading') {
            addButton('Choose a location…', () => {
                this._indicator.menu.close();
                this.openPreferences();
            });
        }
        if (buttons.get_n_children() > 0)
            box.add_child(buttons);
        return box;
    }

    // ---- Footer ----

    _fillFooter() {
        if (!this._footerBox)
            return;
        this._footerBox.destroy_all_children();

        this._footerBox.add_child(this._iconButton('view-refresh-symbolic', 'Refresh', () => {
            this._manager?.refresh({force: true});
        }));

        const status = new St.Label({
            text: this._updatedText(),
            style_class: 'cw-updated',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._model && !this._manager?.busy && (this._manager?.lastError || this._manager?.isStale()))
            status.add_style_class_name('cw-stale');
        this._footerBox.add_child(status);

        if (this._model && this._view !== 'daily') {
            const count = this._pageCount();
            if (count > 1) {
                const page = this._pageIndex();
                const prev = this._iconButton('go-previous-symbolic', 'Previous day', () => this._setPage(page - 1));
                const next = this._iconButton('go-next-symbolic', 'Next day', () => this._setPage(page + 1));
                for (const [button, enabled] of [[prev, page > 0], [next, page < count - 1]]) {
                    button.reactive = enabled;
                    button.can_focus = enabled;
                    button.opacity = enabled ? 255 : 90;
                }
                this._footerBox.add_child(prev);
                this._footerBox.add_child(new St.Label({
                    text: this._dayName(this._shownDate(), false),
                    style_class: 'cw-page',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                this._footerBox.add_child(next);
            }
        }

        this._footerBox.add_child(this._iconButton('emblem-system-symbolic', 'Preferences', () => {
            this._indicator.menu.close();
            this.openPreferences();
        }));
    }

    _updatedText() {
        const manager = this._manager;
        if (manager?.busy)
            return 'Updating…';
        if (!this._model)
            return '';
        const time = formatUnixClock(this._model.fetchedAt, this._clockFormat());
        if (manager?.lastError) {
            const offline = !Gio.NetworkMonitor.get_default().network_available;
            return `${offline ? 'Offline' : 'Update failed'} · data from ${time}`;
        }
        return `Updated ${time}`;
    }

    // ---- Day tooltip ----

    _hideTooltip() {
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    _showTooltip(anchor, day) {
        this._hideTooltip();
        if (!this._model)
            return;
        const hours = this._model.hours.filter(h => h.date === day.date);
        const box = buildDayTooltip(day, hours, this._model.units, {
            clockFormat: this._clockFormat(),
            variant: this._variant(),
            coloredUv: this._settings.get_boolean('use-colored-uv'),
        });
        box.style = this._scaleStyle();
        Main.uiGroup.add_child(box);
        this._tooltip = box;

        // Not allocated yet, so measure with preferred sizes.
        const [, tipW] = box.get_preferred_width(-1);
        const [, tipH] = box.get_preferred_height(tipW);
        const [, rowY] = anchor.get_transformed_position();
        const [, rowH] = anchor.get_transformed_size();
        const [menuX] = this._indicator.menu.actor.get_transformed_position();
        const [menuW] = this._indicator.menu.actor.get_transformed_size();
        if (![rowY, rowH, menuX, menuW].every(Number.isFinite)) {
            // Row not laid out yet (e.g. hovered during a rebuild).
            this._hideTooltip();
            return;
        }
        const stageW = global.stage.width;
        const stageH = global.stage.height;

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
