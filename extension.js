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
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {iconName, tempColor, uvStyle, weatherDesc} from './lib/conditions.js';
import {displayName, locationId, readAutoCache} from './lib/location.js';
import {
    createInterfaceSettings, formatHour, formatShortDate, formatUnixClock,
    formatWeekday, resolveClockFormat,
} from './lib/timeFormat.js';
import {WeatherManager} from './lib/weatherManager.js';
import {SLOTS, buildChart, vertical} from './ui/chart.js';
import {buildDayTooltip} from './ui/dayTooltip.js';

const ROWS_PER_PAGE = 8;
const FADE_OUT_MS = 80;
const FADE_IN_MS = 140;
const RANGE_BAR_PX = 100;

const VIEWS = [
    {id: 'hourly', label: 'Hourly'},
    {id: 'chart', label: 'Chart'},
    {id: 'daily', label: 'Daily'},
];

// Hours shown per page, used to keep roughly the same time in view when switching.
const PAGE_HOURS = {hourly: ROWS_PER_PAGE, chart: SLOTS};

// Extension lifecycle: enable() creates everything, disable() must destroy/disconnect all.
export default class CrispsWeatherExtension extends Extension {
    enable() {
        this._model = null;
        this._status = 'loading'; // 'loading' | 'ok' | 'error' | 'no-location'
        this._page = 0;
        this._activeDate = null;
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
        this._model = null;
    }

    _onUpdated(model) {
        const moved = !this._model || locationId(this._model.location) !== locationId(model.location);
        this._model = model;
        this._status = 'ok';
        if (moved) {
            this._page = 0;
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
        this._tabs = null;
        this._viewHolder = null;

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
    }

    _addCurrent() {
        const {current, units, hours, days} = this._model;
        const today = days.find(d => d.isToday) ?? days[0];
        const now = hours[0];

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
        text.add_child(new St.Label({text: weatherDesc(current.code), style_class: 'cw-current-desc'}));
        const detail = [];
        if (current.feels !== null)
            detail.push(`Feels like ${current.feels}°`);
        if (today)
            detail.push(`H ${today.high}°  L ${today.low}°`);
        text.add_child(new St.Label({text: detail.join('  ·  '), style_class: 'cw-current-detail cw-dim'}));
        if (now) {
            const extra = [`Rain ${now.precip}%`, `Wind ${now.wind} ${units.wind}`];
            if (this._settings.get_boolean('show-uv-index') && now.isDay)
                extra.push(`UV ${now.uv}`);
            text.add_child(new St.Label({text: extra.join('  ·  '), style_class: 'cw-current-detail cw-dim'}));
        }
        box.add_child(text);

        this._indicator.menu.addMenuItem(this._contentItem(box));
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
        const hoursPerPage = PAGE_HOURS[view];
        const oldHoursPerPage = PAGE_HOURS[this._view];
        if (hoursPerPage && oldHoursPerPage)
            this._page = Math.floor(this._page * oldHoursPerPage / hoursPerPage);
        else
            this._page = 0;
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

    // Open the hourly table or chart (whichever was used last) for one day.
    _showDay(date) {
        this._activeDate = date;
        this._settings.set_string('popup-view', this._hourView);
    }

    // Hours for the hourly/chart views, honouring the day filter.
    _viewHours() {
        const hours = this._model.hours;
        return this._activeDate ? hours.filter(h => h.date === this._activeDate) : hours;
    }

    _pageCount() {
        if (this._view === 'daily' || this._activeDate && this._view === 'chart')
            return 1;
        return Math.max(1, Math.ceil(this._viewHours().length / PAGE_HOURS[this._view]));
    }

    _setPage(page) {
        if (page < 0 || page >= this._pageCount() || page === this._page)
            return;
        this._transition(() => {
            this._page = page;
        });
    }

    _fillView() {
        if (!this._viewHolder || !this._model)
            return;
        this._page = Math.min(this._page, this._pageCount() - 1);
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
        const row = new St.BoxLayout({style_class: 'cw-subtitle-box', x_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Label({text, style_class: 'cw-subtitle', y_align: Clutter.ActorAlign.CENTER}));
        if (this._activeDate && this._view !== 'daily') {
            const chip = new St.Button({
                label: '✕ All days',
                style_class: 'cw-chip',
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            chip.connect('clicked', () => this._transition(() => {
                // Stay near the chosen day in the unfiltered list.
                const first = this._model.hours.findIndex(h => h.date === this._activeDate);
                this._activeDate = null;
                this._page = Math.max(0, Math.floor(first / PAGE_HOURS[this._view]));
            }));
            row.add_child(chip);
        }
        box.add_child(row);
    }

    // ---- Views ----

    _buildHourly(box) {
        const model = this._model;
        const fmt = this._clockFormat();
        const variant = this._variant();
        const showUv = this._settings.get_boolean('show-uv-index');
        const showPrecip = this._settings.get_boolean('show-precipitation');
        const coloredUv = this._settings.get_boolean('use-colored-uv');

        const hours = this._viewHours()
            .slice(this._page * ROWS_PER_PAGE, (this._page + 1) * ROWS_PER_PAGE);
        const dates = [...new Set(hours.map(h => h.date))];
        this._addSubtitle(box, dates.map(d => this._dayName(d)).join(' & '));

        hours.forEach((h, i) => {
            const row = new St.BoxLayout({style_class: 'cw-row', x_expand: true});
            if (i % 2 === 0)
                row.add_style_class_name('cw-row-alt');

            row.add_child(new St.Label({
                text: h === model.hours[0] ? 'Now' : formatHour(h.time, fmt),
                style_class: 'cw-hour-time',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Icon({
                icon_name: iconName(h.code, h.isDay),
                style_class: 'cw-row-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            if (showPrecip) {
                row.add_child(new St.Label({
                    text: `${h.precip}%`,
                    style_class: 'cw-precip',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            if (showUv) {
                if (h.isDay) {
                    const uv = new St.Label({
                        text: `UV ${h.uv}`,
                        style_class: 'cw-uv',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    if (coloredUv)
                        uv.style = `color: ${uvStyle(h.uv, variant).color};`;
                    else
                        uv.add_style_class_name('cw-dim');
                    row.add_child(uv);
                } else {
                    // No UV at night; keep the column aligned.
                    row.add_child(new St.Widget({style_class: 'cw-uv'}));
                }
            }
            row.add_child(new St.Label({
                text: weatherDesc(h.code),
                style_class: 'cw-cond',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const temp = new St.Label({
                text: `${h.temp}°`,
                style_class: 'cw-temp',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const color = this._tempColor(h.temp);
            if (color)
                temp.style = `color: ${color};`;
            row.add_child(temp);
            box.add_child(row);
        });
    }

    _buildChartView(box) {
        const model = this._model;
        const slots = new Array(SLOTS).fill(null);
        if (this._activeDate) {
            // One calendar day, each hour in its own slot (past hours stay empty).
            for (const h of this._viewHours())
                slots[h.hour] = h;
        } else {
            this._viewHours()
                .slice(this._page * SLOTS, (this._page + 1) * SLOTS)
                .forEach((h, i) => {
                    slots[i] = h;
                });
        }
        const dates = [...new Set(slots.filter(Boolean).map(h => h.date))];
        this._addSubtitle(box, dates.map(d => this._dayName(d)).join(' & '));
        if (dates.length === 0)
            return;

        box.add_child(buildChart({
            slots,
            units: model.units,
            nowTime: model.hours[0]?.time,
            clockFormat: this._clockFormat(),
            colored: this._settings.get_boolean('use-colored-temps'),
            showUv: this._settings.get_boolean('show-uv-index'),
            variant: this._variant(),
        }));
    }

    _buildDaily(box) {
        const model = this._model;
        const days = model.days;
        if (days.length >= 2)
            this._addSubtitle(box, `${formatShortDate(days[0].date)} – ${formatShortDate(days[days.length - 1].date)}`);
        if (days.length === 0)
            return;

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
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
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
        const left = Math.round((day.low - weekMin) / weekRange * RANGE_BAR_PX);
        const width = Math.max(6, Math.round((day.high - day.low) / weekRange * RANGE_BAR_PX));
        const track = new St.BoxLayout({
            style_class: 'cw-range-track',
            style: `width: ${RANGE_BAR_PX}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        track.add_child(new St.Widget({style: `width: ${Math.min(left, RANGE_BAR_PX - width)}px;`}));
        const bar = new St.Widget({style_class: 'cw-range-bar'});
        const lo = this._tempColor(day.low);
        const hi = this._tempColor(day.high);
        bar.style = lo
            ? `width: ${width}px; background-gradient-direction: horizontal; ` +
              `background-gradient-start: ${lo}; background-gradient-end: ${hi};`
            : `width: ${width}px;`;
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
                const prev = this._iconButton('go-previous-symbolic', 'Previous page', () => this._setPage(this._page - 1));
                const next = this._iconButton('go-next-symbolic', 'Next page', () => this._setPage(this._page + 1));
                for (const [button, enabled] of [[prev, this._page > 0], [next, this._page < count - 1]]) {
                    button.reactive = enabled;
                    button.can_focus = enabled;
                    button.opacity = enabled ? 255 : 90;
                }
                this._footerBox.add_child(prev);
                this._footerBox.add_child(new St.Label({
                    text: `${this._page + 1}/${count}`,
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
