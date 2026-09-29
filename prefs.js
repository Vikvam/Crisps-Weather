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
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {createSession, isCancelled} from './lib/http.js';
import {
    displayName, formatCoordinates, locationId, locationServicesEnabled,
    readAutoCache, readFavorites, searchLocations, writeFavorites,
} from './lib/location.js';

// A ComboRow bound to a string/enum setting via a list of [value, label] pairs.
function comboRow(settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        const idx = options.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, idx);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function subtitleFor(loc) {
    const region = [loc.admin1, loc.country].filter(Boolean).join(', ');
    const coords = formatCoordinates(loc.lat, loc.lon);
    return region ? `${region} · ${coords}` : coords;
}

export default class WeatherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.default_width = 520;
        window.default_height = 680;

        const settings = this.getSettings();
        window._settings = settings; // keep alive with the window

        const session = createSession();
        let searchCancellable = null;
        window.connect('close-request', () => {
            searchCancellable?.cancel();
            session.abort();
            return false;
        });

        window.add(this._buildLocationsPage(settings, session, c => {
            searchCancellable?.cancel();
            searchCancellable = c;
        }));
        window.add(this._buildGeneralPage(settings));
    }

    _buildLocationsPage(settings, session, setSearchCancellable) {
        const page = new Adw.PreferencesPage({title: 'Locations', icon_name: 'find-location-symbolic'});

        // "Use this location" radio buttons, keyed by location id. All join
        // the group of the first one (the "Current location" radio).
        const radios = new Map();
        let radioGroup = null;
        const radio = id => {
            const check = new Gtk.CheckButton({
                active: settings.get_string('active-location') === id,
                valign: Gtk.Align.CENTER,
            });
            if (radioGroup)
                check.group = radioGroup;
            else
                radioGroup = check;
            check.connect('toggled', () => {
                if (check.active && settings.get_string('active-location') !== id)
                    settings.set_string('active-location', id);
            });
            radios.set(id, check);
            return check;
        };
        const syncRadios = () => {
            const active = settings.get_string('active-location');
            (radios.get(active) ?? radios.get('auto')).active = true;
        };

        // ---- Current location ----
        const autoGroup = new Adw.PreferencesGroup({
            title: 'Current Location',
            description: 'Detected with Location Services, or approximately from your IP address.',
        });
        page.add(autoGroup);

        const autoRow = new Adw.ActionRow({title: 'Current location', use_markup: false});
        const autoRadio = radio('auto');
        autoRow.add_prefix(autoRadio);
        autoRow.activatable_widget = autoRadio;
        const redetect = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Detect again',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        redetect.connect('clicked', () => settings.set_string('auto-location-cache', ''));
        autoRow.add_suffix(redetect);
        autoGroup.add(autoRow);

        const syncAutoRow = () => {
            const cache = readAutoCache(settings);
            const via = {geoclue: 'Location Services', ip: 'IP address'}[cache?.source] ?? '';
            autoRow.subtitle = cache
                ? `${displayName(cache.location)}${via ? ` · via ${via}` : ''}`
                : locationServicesEnabled() || settings.get_boolean('allow-ip-lookup')
                    ? 'Not detected yet'
                    : 'Unavailable: Location Services and IP lookup are both off';
        };
        syncAutoRow();
        settings.connect('changed::auto-location-cache', syncAutoRow);
        settings.connect('changed::allow-ip-lookup', syncAutoRow);

        autoGroup.add(switchRow(settings, 'allow-ip-lookup', 'Allow IP-based lookup',
            'Used when Location Services are off or unavailable. Sends your IP address to ipinfo.io.'));

        // ---- Favourites ----
        const favGroup = new Adw.PreferencesGroup({title: 'Favourites'});
        page.add(favGroup);
        let favRows = [];

        const iconButton = (icon, tooltip, sensitive, onClick) => {
            const b = new Gtk.Button({
                icon_name: icon, tooltip_text: tooltip, sensitive,
                valign: Gtk.Align.CENTER, css_classes: ['flat'],
            });
            b.connect('clicked', onClick);
            return b;
        };

        const rebuildFavorites = () => {
            for (const r of favRows)
                favGroup.remove(r);
            favRows = [];
            for (const id of [...radios.keys()]) {
                if (id !== 'auto')
                    radios.delete(id);
            }

            const favorites = readFavorites(settings);
            if (favorites.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No favourites yet',
                    subtitle: 'Search for a place below to add one.',
                });
                favGroup.add(empty);
                favRows.push(empty);
                return;
            }

            const move = (from, to) => {
                const list = readFavorites(settings);
                const [item] = list.splice(from, 1);
                list.splice(to, 0, item);
                writeFavorites(settings, list);
            };

            favorites.forEach((fav, i) => {
                const id = locationId(fav);
                const row = new Adw.ActionRow({title: displayName(fav), subtitle: subtitleFor(fav), use_markup: false});
                const check = radio(id);
                row.add_prefix(check);
                row.activatable_widget = check;
                row.add_suffix(iconButton('go-up-symbolic', 'Move up', i > 0, () => move(i, i - 1)));
                row.add_suffix(iconButton('go-down-symbolic', 'Move down', i < favorites.length - 1, () => move(i, i + 1)));
                row.add_suffix(iconButton('user-trash-symbolic', 'Remove', true, () => {
                    writeFavorites(settings, readFavorites(settings).filter(f => locationId(f) !== id));
                    if (settings.get_string('active-location') === id)
                        settings.set_string('active-location', 'auto');
                }));
                favGroup.add(row);
                favRows.push(row);
            });
        };

        rebuildFavorites();
        settings.connect('changed::favorites', () => {
            rebuildFavorites();
            syncRadios();
        });
        settings.connect('changed::active-location', syncRadios);

        // ---- Add location ----
        const addGroup = new Adw.PreferencesGroup({
            title: 'Add Location',
            description: 'A city name, a postal code (optionally with a country, e.g. "11000, CZ"), or coordinates such as "50.08, 14.42". Press Enter to search.',
        });
        page.add(addGroup);

        const entry = new Adw.EntryRow({title: 'Search', show_apply_button: true});
        const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, visible: false});
        entry.add_suffix(spinner);
        addGroup.add(entry);
        let resultRows = [];

        const clearResults = () => {
            for (const r of resultRows)
                addGroup.remove(r);
            resultRows = [];
        };
        const addResultRow = row => {
            addGroup.add(row);
            resultRows.push(row);
        };

        const runSearch = async () => {
            const text = entry.text.trim();
            if (!text)
                return;
            const cancellable = new Gio.Cancellable();
            setSearchCancellable(cancellable);
            clearResults();
            spinner.visible = spinner.spinning = true;

            try {
                const results = await searchLocations(session, text, cancellable);
                if (cancellable.is_cancelled())
                    return;
                if (results.length === 0)
                    addResultRow(new Adw.ActionRow({title: 'No places found', subtitle: text, use_markup: false}));

                for (const loc of results) {
                    const row = new Adw.ActionRow({
                        title: displayName(loc),
                        subtitle: subtitleFor(loc),
                        use_markup: false,
                        activatable: true,
                    });
                    row.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
                    row.connect('activated', () => {
                        const id = locationId(loc);
                        const favorites = readFavorites(settings);
                        if (!favorites.some(f => locationId(f) === id))
                            writeFavorites(settings, [...favorites, loc]);
                        settings.set_string('active-location', id);
                        clearResults();
                        entry.text = '';
                    });
                    addResultRow(row);
                }
            } catch (e) {
                if (!isCancelled(e)) {
                    addResultRow(new Adw.ActionRow({
                        title: 'Search failed',
                        subtitle: e.message ?? String(e),
                        use_markup: false,
                    }));
                }
            } finally {
                if (!cancellable.is_cancelled())
                    spinner.visible = spinner.spinning = false;
            }
        };
        entry.connect('apply', runSearch);
        entry.connect('entry-activated', runSearch);

        return page;
    }

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const unitGroup = new Adw.PreferencesGroup({title: 'Units'});
        page.add(unitGroup);
        unitGroup.add(comboRow(settings, 'temperature-unit', 'Temperature Unit',
            'Wind speed follows: km/h or mph',
            [['celsius', 'Celsius'], ['fahrenheit', 'Fahrenheit']]));
        unitGroup.add(comboRow(settings, 'clock-format', 'Clock Format', null,
            [['system', 'System default'], ['24h', '24-hour'], ['12h', '12-hour']]));

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);
        panelGroup.add(comboRow(settings, 'panel-display', 'Show in Panel', null,
            [['temp', 'Temperature'], ['icon', 'Weather icon'], ['temp-icon', 'Temperature and icon']]));
        const posRow = comboRow(settings, 'temperature-position', 'Temperature Position',
            'Relative to the icon', [['left', 'Left'], ['right', 'Right']]);
        const syncPos = () => {
            posRow.sensitive = settings.get_string('panel-display') === 'temp-icon';
        };
        syncPos();
        settings.connect('changed::panel-display', syncPos);
        panelGroup.add(posRow);

        const refreshGroup = new Adw.PreferencesGroup({title: 'Updates'});
        page.add(refreshGroup);
        const intervalRow = Adw.SpinRow.new_with_range(15, 240, 15);
        intervalRow.title = 'Refresh Interval';
        intervalRow.subtitle = 'Minutes between forecast updates';
        intervalRow.value = settings.get_uint('refresh-interval');
        intervalRow.connect('notify::value', () => {
            const v = Math.round(intervalRow.value);
            if (v !== settings.get_uint('refresh-interval'))
                settings.set_uint('refresh-interval', v);
        });
        refreshGroup.add(intervalRow);

        const displayGroup = new Adw.PreferencesGroup({title: 'Forecast'});
        page.add(displayGroup);
        displayGroup.add(switchRow(settings, 'show-uv-index', 'Show UV Index',
            'In hourly forecast rows'));
        displayGroup.add(switchRow(settings, 'show-precipitation', 'Show Rain Chance',
            'In hourly forecast rows'));
        displayGroup.add(switchRow(settings, 'use-colored-temps', 'Dynamic Temperature Color',
            'Blue-to-red gradient for temperatures'));
        displayGroup.add(switchRow(settings, 'use-colored-uv', 'Dynamic UV Color',
            'Color-coded UV index labels'));

        return page;
    }
}
