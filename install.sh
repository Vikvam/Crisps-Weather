#!/bin/sh
# Pack, install and enable Crisps Weather for the current user.
#
# GNOME Shell on Wayland can't be restarted in place: new or updated
# extension code is only loaded after logging out and back in.
#   ./install.sh            install, then ask whether to log out now
#   ./install.sh --logout   install and log out without asking
set -eu
cd "$(dirname "$0")"

UUID=crisps-weather@vikvam.github.io

./pack.sh
gnome-extensions install --force "$UUID.shell-extension.zip"
# Enabling works even before the shell has loaded the extension; it takes
# effect at the next login.
gnome-extensions enable "$UUID" 2>/dev/null ||
    gsettings set org.gnome.shell enabled-extensions \
        "$(gsettings get org.gnome.shell enabled-extensions | sed "s/]$/, '$UUID']/; s/\[, /[/; s/@as \[\]/['$UUID']/")"
echo "Installed and enabled $UUID."

if gnome-extensions list --enabled | grep -q '^weather@chip$'; then
    echo "Note: the original Chips Weather (weather@chip) is also enabled;"
    echo "      disable it with: gnome-extensions disable weather@chip"
fi

if [ "${1:-}" = "--logout" ]; then
    gnome-session-quit --logout --no-prompt
else
    printf 'Log out now to load it? [y/N] '
    read -r answer
    case "$answer" in
        [yY]*) gnome-session-quit --logout --no-prompt ;;
        *) echo "Log out and back in when ready." ;;
    esac
fi
