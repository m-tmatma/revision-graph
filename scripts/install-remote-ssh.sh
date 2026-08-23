#!/bin/sh
# Installs the extension's .vsix into a remote VS Code Server -- run this
# script directly on the remote host (e.g. `scp` it there together with the
# .vsix, then `ssh host sh install-remote-ssh.sh`), not from your local
# machine.
#
# A plain `ssh` session's PATH isn't reliable for this: whatever "code" is
# first in it there may be an unrelated local install on the remote
# machine, or resolve to nothing at all (see the README's "Using
# Remote-SSH" note). This script instead finds the running VS Code
# Server's own CLI binary directly under ~/.vscode-server(-insiders), which
# always targets the extension host actually running on this machine --
# the same one Remote-SSH, Dev Containers, and WSL connections all use.
# Two layouts are checked, since this varies by VS Code version:
#   - ~/.vscode-server/code-<commit>                     (current)
#   - ~/.vscode-server/bin/<commit>/bin/remote-cli/code   (older)
#
# This needs the server to have started at least once already (i.e. you've
# connected from a VS Code window before) -- the binary doesn't exist until
# then. If more than one VS Code Server version is present from past
# connections, the most recently used one is picked.
#
# --extensions-dir is passed explicitly, pointing at this same
# ~/.vscode-server(-insiders)'s own "extensions" folder: run bare (not as
# part of an active server session), this CLI binary otherwise defaults to
# the *local Desktop* extensions folder (~/.vscode/extensions) even though
# the binary itself lives under ~/.vscode-server -- confirmed on a real
# host, where the extension landed there instead and so was invisible to
# the actual remote extension host.
set -e
cd "$(dirname "$0")"

VSIX=$(ls -1 *.vsix 2>/dev/null | head -n 1)
if [ -z "$VSIX" ]; then
    echo "No .vsix file found next to this script."
    exit 1
fi

REMOTE_CLI=$(ls -t "$HOME"/.vscode-server*/code-* "$HOME"/.vscode-server*/bin/*/bin/remote-cli/code 2>/dev/null | head -n 1)
if [ -z "$REMOTE_CLI" ]; then
    echo "No VS Code Server found under ~/.vscode-server(-insiders)."
    echo "Connect to this host from VS Code at least once first, then try again."
    exit 1
fi

case "$REMOTE_CLI" in
    */bin/*/bin/remote-cli/code) SERVER_ROOT=${REMOTE_CLI%/bin/*/bin/remote-cli/code} ;;
    *) SERVER_ROOT=${REMOTE_CLI%/code-*} ;;
esac
EXTENSIONS_DIR="$SERVER_ROOT/extensions"

echo "Installing $VSIX using $REMOTE_CLI (--extensions-dir $EXTENSIONS_DIR) ..."
"$REMOTE_CLI" --extensions-dir "$EXTENSIONS_DIR" --install-extension "$VSIX"
echo "Done."
