#!/bin/sh
# macOS: double-click this file in Finder to install the extension's .vsix
# into VS Code (it opens Terminal and runs install.sh next to it).
cd "$(dirname "$0")"
sh ./install.sh
status=$?
echo
read -p "Press Enter to close..." _
exit "$status"
