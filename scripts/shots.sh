#!/usr/bin/env bash
# Takes the screenshots of the module in the sandboxed headless shell of the
# Visor repository, with invented sessions (tests/shell/fixture.py), in the
# dark and the light scheme:
#
#   docs/screenshots/claude-<scheme>.png        the open panel, 1920×1080
#   docs/screenshots/claude-peek-<scheme>.png   the chip of a waiting session
#   catalog/<uuid>/screenshot-<n>.png           the module alone in the panel, close up on
#                                               the wallpaper of Visor, 1600×1000, for the catalog
#
# Usage: scripts/shots.sh
set -uo pipefail
cd "$(dirname "$0")/.."
source tests/shell/lib.sh

if [[ "${1:-}" == --inside ]]; then
    inside
    shell_wait_for "$entry != null && $entry.active" 15
    # The pictures of the catalog: the module alone in the panel, close up.
    [[ "$2" == catalog ]] && dconf write /org/gnome/shell/extensions/visor/disabled-modules "['upcoming', 'notifications']"
    project=/home/ada/code/lighthouse
    # A window the waiting session was started from, out of the way.
    gjs -m "$repo/tests/shell/window.js" 'Terminal' >"$HOME/window.out" 2>/dev/null &
    shell_wait_for "global.get_window_actors().some(a => a.meta_window.title === 'Terminal')" 20
    for _ in $(seq 1 50); do [[ -s "$HOME/window.out" ]] && break; sleep 0.1; done
    wait="$(head -n 1 "$HOME/window.out")"
    run "global.get_window_actors().find(a => a.meta_window.title === 'Terminal').meta_window.minimize()"
    # The shell announces the new window ("is ready"); that is not what the picture is about.
    shell_wait_for 'Main.messageTray.getSources().length > 0' 3 2>/dev/null || true
    run 'Main.messageTray.getSources().forEach(source => source.destroy())'
    shell_wait_for 'visor.notch.state !== "peek"' 6 2>/dev/null || true
    work="$(stand_in)" done="$(stand_in)"
    fixture transcript "$(session_id "$wait")" "$project" 'prompt:Fix the tide parser' \
        'say:The parser handles the leap second now. I would like to run the tests of the tide tables before I go on.' \
        'bash:call-1:pnpm test --filter tides'
    fixture transcript "$(session_id "$work")" "$project" 'prompt:Draw the map' 'say:Drawing the quay and the two piers.'
    fixture transcript "$(session_id "$done")" /home/ada/code/buoy-api 'prompt:Changelog' 'say:The changelog has the three fixes of this week.'
    fixture session "$wait" --name 'Fix the tide parser' --status waiting --waiting-for 'permission prompt'
    fixture session "$work" --name 'Draw the harbour map' --status busy --status-ago 257
    fixture session "$done" --name 'Update the changelog' --cwd /home/ada/code/buoy-api --status idle --status-ago 20
    shell_wait_for "$entry.rows.length === 3 && $entry.rows[0].detail !== undefined && $entry.rows[0].primary !== undefined" 15
    if [[ "$2" == peek ]]; then
        shell_wait_for 'visor.notch.state === "peek"' 5
        sleep 0.4
    else
        run 'visor.notch.open()'
        shell_wait_for 'visor.notch.state === "open"'
        run "$(find visor-row-chevron).find(c => c.mapped).emit('clicked', 1)"
        shell_wait_for "$(find visor-claude-message).some(a => a.mapped)"
        sleep 0.6
    fi
    if [[ "$2" == catalog ]]; then shell_shot_focus "$3" visor-sheet 0 --frame; else shell_shot "$3"; fi
    exit 0
fi

fail=0
# shot KIND FILE [options of nested.sh]
shot() {
    local kind="$1" file="$2" noise
    shift 2
    mkdir -p "$(dirname "$file")"
    if ! nested "$@" --log "$repo/.shell-test/shots.log" -- "$repo/scripts/shots.sh" --inside "$kind" "$file" >/dev/null 2>&1; then
        echo "FAIL  ${file#"$repo"/}: the scenario did not run"
        fail=1
        return
    fi
    # What the shell says while it shuts down is not about the scenario.
    noise="$(sed '/Shutting down GNOME Shell/,$d' "$repo/.shell-test/shots.log" |
        grep -E 'JS ERROR|CRITICAL|Gjs-WARNING|St-WARNING|Clutter-WARNING|visor' || true)"
    if [[ -n "$noise" ]]; then
        echo "FAIL  ${file#"$repo"/}: the shell logged"
        head -n 10 <<<"$noise"
        fail=1
        return
    fi
    echo "ok    ${file#"$repo"/}"
}

PATH="$repo/node_modules/.bin:$PATH" bash scripts/build.sh >/dev/null || { echo "FAIL  build"; exit 1; }
number=0
for scheme in dark light; do
    number=$((number + 1))
    shot open "$repo/docs/screenshots/claude-$scheme.png" --scheme "$scheme"
    shot peek "$repo/docs/screenshots/claude-peek-$scheme.png" --scheme "$scheme"
    # 1600x1000 as the catalog wants, from a monitor four times as sharp, as a card on the wallpaper of Visor.
    shot catalog "$repo/catalog/$uuid/screenshot-$number.png" --scheme "$scheme" \
        --size 6400x4000 --scale 4
done
exit "$fail"
