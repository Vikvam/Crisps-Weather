# <img src="icon.svg" width="48" align="left"> Crisps Weather

GNOME Shell extension showing current weather in the panel with an hourly and daily forecast popup.

Crisps Weather is a fork of [Chips Weather](https://github.com/ninjabucket/Chips-Weather) by ninjabucket,
with a rewritten backend, favourite locations and timezone-correct forecasts. It uses its own UUID and
settings, so it can be installed alongside the original.

## Features

- **Panel indicator**: the current temperature, the weather icon, or both
- **Current conditions**: temperature, feels-like, today's high/low, sunrise/sunset, rain chance, wind and UV
- **Location details**: coordinates, elevation, timezone and local time (when it differs from yours)
- **Three forecast views**, switchable in the popup (the last one is remembered), paged by day:
  - **Hourly**: table with optional columns for rain chance and amount, wind, UV index, humidity, air quality and feels-like
  - **Chart**: temperature (with UV bars and a feels-like line), rain chance with amount bars, wind and gusts,
    humidity and air quality, stacked on one hour axis; night hours shaded; hover for details
  - **Daily**: 7-day forecast with high/low range bars; hover a day for details, click it for its hours
- **Rain soon**: "Rain likely in ~30 min" from 15-minute precipitation data
- **Air quality and pollen** (optional): European AQI, pollen in Europe
- **Favourite locations**: search by city name, postal code (e.g. `11000, CZ`) or coordinates (`50.08, 14.42`), and switch between them from the popup
- **Automatic location**: GNOME Location Services (GeoClue), falling back to IP geolocation (can be turned off)
- **Correct local time**: forecasts are shown in the location's own timezone, so far-away favourites show the right "Now" and "Today"
- **12/24-hour clock**: follows the system setting by default
- **Configurable refresh**: every 60 minutes by default (15–240), also refreshed after resume or reconnect when the data is stale; the popup shows when the data was fetched and whether the last update failed
- **Light and dark shell styles** (GNOME 47+), color-coded temperatures and UV (optional)
- **Keyboard accessible** popup
- **Open-Meteo**: free weather API, no key required

![Hourly, chart and daily views](screenshot.png)

## Compatibility

GNOME Shell 45, 46, 47, 48, 49, 50

## Installation

```bash
git clone https://github.com/Vikvam/Chips-Weather.git
cd Chips-Weather
./install.sh
```

This packs, installs and enables the extension. GNOME Shell only loads newly installed or
updated extension code at login, so log out and back in afterwards (the script offers to).

## Preferences

**Locations**
- Current location: detected location, re-detect, allow/disallow IP-based lookup
- Favourites: choose the active location, reorder, remove
- Add location: search by name, postal code or coordinates

**General**
- Temperature unit (Celsius / Fahrenheit; wind follows as km/h / mph)
- Clock format (system default / 24-hour / 12-hour)
- Panel display (temperature / icon / both) and temperature position
- Refresh interval
- Text size, weather icons, dynamic temperature and UV colors
- Data: rain chance, rain amount, wind, UV index, humidity, feels-like, air quality (table columns and charts)

## Data Sources

- Weather, air quality and geocoding: [Open-Meteo](https://open-meteo.com) (air quality from CAMS)
- Postal code and place search fallback: [Nominatim / OpenStreetMap](https://nominatim.openstreetmap.org) (only when you search in Preferences)
- Automatic location: GNOME Location Services, or [ipinfo.io](https://ipinfo.io) when allowed
- Coordinate names: GWeather's offline city database

## Development

```bash
gjs -m tests/run.js   # unit tests for lib/ (no GNOME Shell needed)
./pack.sh             # build crisps-weather@vikvam.github.io.shell-extension.zip
```

## License

GPL-2.0-or-later, see [COPYING](COPYING).
Original work © 2026 chip ([ninjabucket](https://github.com/ninjabucket)); modifications © 2026 Vikvam.
