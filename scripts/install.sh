#!/bin/sh
# Installs the extension's .vsix into VS Code.
# Linux: mark as executable and enable "Run" on double-click in your file
# manager, or run it from a terminal: sh install.sh
set -e
cd "$(dirname "$0")"

if ! command -v code >/dev/null 2>&1; then
    echo '"code" command was not found in PATH.'
    echo 'Open VS Code, run "Shell Command: Install '"'"'code'"'"' command in PATH" from the Command Palette, then try again.'
    exit 1
fi

VSIX=$(ls -1 *.vsix 2>/dev/null | head -n 1)
if [ -z "$VSIX" ]; then
    echo "No .vsix file found next to this script."
    exit 1
fi

echo "Installing $VSIX ..."
code --install-extension "$VSIX"
echo "Done."
