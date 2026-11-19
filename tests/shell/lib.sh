#!/usr/bin/env bash
# Shared by the shell tests of this directory. They run the module next to
# Visor in the sandboxed headless GNOME Shell of the Visor repository
# (scripts/nested.sh there: own HOME, session bus, settings and keyring, so
# nothing reaches the session you are logged in to).
#
# VISOR_REPO is a checkout of https://github.com/taulit/visor with `pnpm build`
# done. Default: ../visor next to this repository.
#
# A test has two parts. Outside the sandbox it calls `nested -- "$0" --inside`;
# inside it calls `inside` and then checks the shell with `check`, `wait_check`
# and `run`, which evaluate JavaScript in the shell. In scope there: Main, St,
# Clutter, Gio, GLib, Shell, Meta and `visor`, the running Visor extension
# (`visor.api`, `visor.notch`, `visor.content.registry`). Those objects of
# Visor are not part of the module API and may change; use them in tests only.

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${VISOR_REPO:-}" ]]; then
    VISOR_REPO="$repo/../visor"
    # The template inside the Visor repository itself.
    [[ -x "$repo/../../scripts/nested.sh" ]] && VISOR_REPO="$repo/../.."
fi
visor_repo="$(cd "$VISOR_REPO" 2>/dev/null && pwd || true)"
visor_uuid='visor@taulit.github.io'
uuid="$(node -p "require('$repo/metadata.json').uuid")"
# The id the module registers with, see "visor" in metadata.json.
module_id="$(node -p "require('$repo/metadata.json').visor.id")"

# nested [options of nested.sh] -- command: the sandbox with Visor and this module.
nested() {
    [[ -n "$visor_repo" && -x "$visor_repo/scripts/nested.sh" && -f "$visor_repo/build/metadata.json" ]] || {
        echo "No built Visor in ${VISOR_REPO}: set VISOR_REPO to a checkout of taulit/visor and run 'pnpm build' there." >&2
        exit 2
    }
    [[ -f "$repo/build/metadata.json" ]] || { echo "Run 'pnpm build' first." >&2; exit 2; }
    mkdir -p "$repo/.shell-test"
    "$visor_repo/scripts/nested.sh" --extension "$repo/build" "$@"
}

fail=0
# inside: call first in the part of a test that runs in the sandbox.
inside() {
    # The tests write and remove files below ~/.claude: only ever in the sandbox.
    [[ -n "${VISOR_SANDBOX:-}" && "$HOME" == "$VISOR_SANDBOX"/* && "$HOME" == *visor-shell.* ]] || {
        echo "This part of the test runs in the sandbox of scripts/nested.sh only." >&2
        exit 2
    }
    claude_dir="$HOME/.claude"
    source "$visor_repo/scripts/lib/shell.sh"
    shell_wait_for 'visor !== null && visor.api !== null'
    shell_wait_for "Main.extensionManager.lookup('$uuid')?.state === 1" 15
    log_before="$(wc -l <"$HOME/shell.log")"
    # The settings of the module, for `gsettings get` and `gsettings set`.
    export GSETTINGS_SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/$uuid/schemas"
}

# check NAME JS: passes when JS evaluates to true.
check() {
    local got
    got="$(shell_eval "$2" 2>&1)" || true
    if [[ "$got" == true ]]; then echo "ok    $1"; else echo "FAIL  $1: $got"; fail=1; fi
}
# wait_check NAME JS [seconds]: like check, but gives JS time to become true.
wait_check() {
    if shell_wait_for "$2" "${3:-5}" 2>/dev/null; then
        echo "ok    $1"
    else
        echo "FAIL  $1: $(shell_eval "$2" 2>&1 || true)"
        fail=1
    fi
}
# run JS: evaluates JS for its effect.
run() { shell_eval "$1" >/dev/null; }

# --- invented Claude Code sessions, in the HOME of the sandbox only ---

# fixture ARGS: tests/shell/fixture.py, which refuses to write outside the sandbox.
fixture() { python3 "$repo/tests/shell/fixture.py" "$@"; }
# stand_in: starts a process that stands in for Claude Code and prints its pid.
stand_in() {
    sleep 100000 >/dev/null 2>&1 &
    echo $!
}
# transcript_of PID: the session id fixture.py gives the session of that process.
session_id() { printf '00000000-0000-4000-8000-%012d' "$1"; }

# The entry of the module in the registry of Visor, and the state of an extension, as JS.
entry="visor.content.registry.get('$module_id')"
state() { printf "Main.extensionManager.lookup('%s')?.state" "$1"; }
# find CLASS: all actors below the notch with that style class, as JS.
find() { printf "(function find(a, out) { if (a.has_style_class_name && a.has_style_class_name('%s')) out.push(a); for (const c of a.get_children()) find(c, out); return out; })(visor.notch.root, [])" "$1"; }

# finish: fails when the shell logged a warning or an error since `inside`, or
# anything about this extension at all; prints PASS and ends the test.
finish() {
    local noise
    noise="$({
        tail -n "+$((log_before + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|has been already disposed' || true
        grep -E "JS ERROR|CRITICAL|$uuid|Failed to (load|enable)" "$HOME/shell.log" || true
    })"
    if [[ -z "$noise" ]]; then
        echo "ok    no shell warnings"
    else
        echo "FAIL  shell warnings:"
        head -n 20 <<<"$noise"
        fail=1
    fi
    ((fail == 0)) && echo "PASS"
    exit "$fail"
}
