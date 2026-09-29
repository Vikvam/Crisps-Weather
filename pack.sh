#!/bin/sh
# Build crisps-weather@vikvam.github.io.shell-extension.zip for installation or upload to extensions.gnome.org.
set -eu
cd "$(dirname "$0")"
gnome-extensions pack --force --extra-source=lib --out-dir=. .
echo "Built $(pwd)/crisps-weather@vikvam.github.io.shell-extension.zip"
