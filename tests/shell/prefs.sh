#!/usr/bin/env bash
# The settings window of the module in the sandboxed headless shell: it opens,
# says what the module reads and where, and its one switch writes the setting
# the module follows. The window is driven with the pointer and read through
# the accessibility bus.
#
# Usage: tests/shell/prefs.sh
# The log ends up in .shell-test/prefs.log, the output of the window in .shell-test/prefs.window.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" != --inside ]]; then
    mkdir -p "$repo/.shell-test"
    window="$repo/.shell-test/prefs.window"
    status=0
    nested --log "$repo/.shell-test/prefs.log" -- "$repo/tests/shell/prefs.sh" --inside >"$window" 2>&1 || status=$?
    grep -E '^(ok|FAIL|PASS)' "$window" || true
    noise="$(grep -E '^\(org\.gnome\.Shell\.Extensions:|JS ERROR|Visor' "$window" |
        grep -v '^ok\|^FAIL\|atspi\|visible-page' || true)"
    if [[ -n "$noise" ]]; then
        echo "FAIL  the window process logged:"
        head -n 10 <<<"$noise"
        exit 1
    fi
    echo "ok    the window process logged no error"
    exit "$status"
fi

inside
source "$visor_repo/scripts/lib/prefs.sh"
# The window of this module, not the one of Visor.
PREFS_WINDOW='Visor: Claude Code'
key=flash-on-waiting-sessions
schema=org.gnome.shell.extensions.visor-claude
expect_shows() {
    if prefs_shows "$2"; then echo "ok    $1"; else echo "FAIL  $1: the window does not show '$2'"; fail=1; fi
}

prefs_a11y
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.OpenExtensionPrefs "$uuid" '' '{}' >/dev/null
shell_wait_for "global.get_window_actors().some(a => a.meta_window.title === '$PREFS_WINDOW')" 20
sleep 1
# The first click after the window opens is lost; this one hits the margin of the page.
prefs_click 20 400

expect_shows 'the window names what it shows' 'Sessions'
expect_shows 'and the folder it reads, with ~ for the home directory' '~/.claude'
expect_shows 'it has the switch for the flash' 'Show briefly when a session is waiting'
if prefs_shows 'Visor is not installed'; then
    echo 'FAIL  the hint about a missing Visor shows although Visor is there'
    fail=1
else
    echo 'ok    no hint about a missing Visor'
fi
[[ "$(gsettings get "$schema" "$key")" == true ]] && echo 'ok    the flash is on by default' || { echo 'FAIL  the flash is not on by default'; fail=1; }
prefs_click_on 'Show briefly when a session is waiting'
for _ in $(seq 1 25); do [[ "$(gsettings get "$schema" "$key")" == false ]] && break; sleep 0.2; done
[[ "$(gsettings get "$schema" "$key")" == false ]] && echo 'ok    a click on the row turns it off' || { echo 'FAIL  the click did not change the setting'; fail=1; }
check 'the module in the shell reads the same setting' "$entry.module.ctx.settings.get_boolean('$key') === false"
if [[ ! -e "$claude_dir" ]]; then
    echo 'ok    the window created nothing below ~/.claude'
else
    echo 'FAIL  the window created ~/.claude'
    fail=1
fi
# The window goes with the sandbox: closing it from the shell makes mutter warn about the test itself.
finish
