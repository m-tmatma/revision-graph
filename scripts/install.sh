#!/bin/sh
# Installs the extension's .vsix into VS Code.
# Linux: mark as executable and enable "Run" on double-click in your file
# manager, or run it from a terminal: sh install.sh
#
# Using Remote-SSH (or Dev Containers/WSL)? Running this from a plain `ssh`
# session on the remote host is not reliable -- whatever "code" is first in
# PATH there may be an unrelated local install, installing the extension to
# the wrong place. Use install-remote-ssh.sh instead, or see the README's
# "Using Remote-SSH" note.
set -e
cd "$(dirname "$0")"

if ! command -v code >/dev/null 2>&1; then
    echo '"code" command was not found in PATH.'
    echo 'Open VS Code, run "Shell Command: Install '"'"'code'"'"' command in PATH" from the Command Palette, then try again.'
    exit 1
fi

# Not `ls -1 *.vsix | head -n 1` -- a filename starting with "-" would
# otherwise be parsed as an ls option instead of a file. The leading "./"
# keeps the selected path unambiguous too.
VSIX=
for f in ./*.vsix; do
    [ -e "$f" ] || continue
    VSIX=$f
    break
done
if [ -z "$VSIX" ]; then
    echo "No .vsix file found next to this script."
    exit 1
fi

echo "Installing $VSIX using $(command -v code) ..."
code --install-extension "$VSIX"
echo "Done."
