#!/usr/bin/env bash
# Drives the Claude Code module in the sandboxed headless shell with invented
# session files and transcripts below the HOME of the sandbox (never the real
# ~/.claude): no folder at all, a session that works, one that waits for a
# permission (amber row, chip, dot, flash), a question, a reason nobody knows,
# the expanded row, a finished session and its two minutes, "+ n more", the
# window of a session, files that are broken, huge or left behind by a dead
# process, and the module turned off. At the end: nothing of a transcript is
# in the log, nothing was written to ~/.claude, and the code makes no request.
#
# Usage: tests/shell/claude.sh
# The log ends up in .shell-test/claude.log.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" != --inside ]]; then
    nested --log "$repo/.shell-test/claude.log" -- "$repo/tests/shell/claude.sh" --inside
    exit
fi

inside
shell_wait_for "$entry != null && $entry.active" 15
run 'Main.overview.hide()'
shell_wait_for '!Main.overview.visible'

run "(() => {
    const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(true), false)));
    const up = (actor, cls) => {
        while (actor && !actor.has_style_class_name(cls)) actor = actor.get_parent();
        return actor ?? null;
    };
    const entry = () => visor.content.registry.get('claude');
    globalThis.A = {
        wait,
        find: cls => $(find "' + cls + '"),
        mod: () => entry().module,
        rows: () => entry().rows,
        row: pid => entry().rows.find(r => r.id === 'claude:' + pid),
        ids: () => entry().rows.map(r => r.id.slice(7)).join(),
        chip: () => entry().chip,
        actor: title => up(A.find('visor-row-title').find(a => a.mapped && a.text === title), 'visor-row'),
        chevron: title => A.find('visor-row-chevron').find(c => A.actor(title).contains(c)),
        message: () => A.find('visor-claude-message').find(a => a.mapped),
        hint: () => A.find('visor-claude-hint').find(a => a.mapped),
        show: () => A.find('visor-claude-buttons').find(a => a.mapped)?.get_first_child(),
        dot: () => A.find('visor-dot')[0] ?? Main.panel._centerBox.get_first_child().get_first_child().get_last_child(),
        focus: () => global.display.focus_window?.title ?? null,
    };
    return true;
})()"
open_panel() { run 'visor.notch.open()'; shell_wait_for 'visor.notch.state === "open"'; }
close_panel() { run 'visor.notch.close()'; shell_wait_for 'visor.notch.state !== "open"'; }

project=/home/ada/code/lighthouse

# --- Claude Code was never used on this machine --------------------------------

check 'the test has a HOME of its own without a folder of Claude Code' \
    "GLib.get_home_dir() === '$HOME' && !GLib.file_test('$HOME/.claude', GLib.FileTest.EXISTS)"
check 'without the folder the module is empty and runs no timer' \
    "A.rows().length === 0 && A.chip() === null && A.mod().tickSource === 0 && A.mod().aliveSource === 0 && A.mod().expirySource === 0"
wait_check 'it waits for the folder with one monitor, on the home directory' \
    "A.mod().watcher.monitor !== null && !A.mod().watcher.monitor.is_cancelled()"

# --- a session works -------------------------------------------------------------

work="$(stand_in)"
fixture session "$work" --name 'Harbour map' --status busy --status-ago 252
wait_check 'the folder appears with a session: one row' "A.ids() === '$work'" 8
check 'it names the session and the project and says how long it has worked' \
    "A.row($work).title === 'Harbour map' && /^lighthouse · Working · 4:1[0-9]$/.test(A.row($work).subtitle) && A.row($work).icon === 'content-loading-symbolic' && A.row($work).status === undefined"
check 'nothing waits: no chip, no dot' "A.chip() === null && visor.content.attention === null"
check 'the time does not tick while the panel is closed, but the process is looked after' \
    "A.mod().tickSource === 0 && A.mod().aliveSource !== 0"
check 'a row with nothing to read and nowhere to go has nothing to expand' "A.row($work).expand === undefined"

# --- what is no session ------------------------------------------------------------

sleep 100000 &
dead=$!
fixture session "$dead" --name 'Left behind'
wait_check 'a second session' "A.rows().length === 2"
kill "$dead"; wait "$dead" 2>/dev/null || true
open_panel
wait_check 'a process that was killed loses its row when the panel opens' "A.ids() === '$work'"
close_panel
fixture session "$dead" --name 'Left behind' --proc-start 1
other="$(stand_in)"
fixture session "$other" --name 'Not this process' --proc-start 1
spare="$(stand_in)"
fixture session "$spare" --name 'Spare' --spare
daemon="$(stand_in)"
fixture session "$daemon" --name 'Daemon' --kind daemon
fresh="$(stand_in)"
fixture session "$fresh" --name 'Just opened' --status idle --started-ago 30 --status-ago 29.9
broken="$(stand_in)"
fixture session "$broken" --raw '{"pid": '
huge="$(stand_in)"
fixture session "$huge" --raw "{\"pid\": $huge, \"sessionId\": \"huge\", \"status\": \"busy\", \"name\": \"$(head -c 70000 /dev/zero | tr '\0' x)\"}"
unknown="$(stand_in)"
fixture session "$unknown" --name 'From the future' --status hibernating
printf 'not a session' >"$claude_dir/sessions/notes.json"
printf '{}' >"$claude_dir/sessions/$work.abcdef.key"
run 'A.wait(1200)'
check 'a dead process, a reused pid, a spare, a daemon, a session that has not worked, a broken file, a huge one and an unknown status have no row' \
    "A.ids() === '$work'"

# --- a session waits for a permission ----------------------------------------------

wait="$(stand_in)"
fixture transcript "$(session_id "$wait")" "$project" \
    'prompt:Clean the build folder' 'say:I will remove the old build first.' 'bash:call-1:rm -rf build'
fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'permission prompt'
wait_check 'a session that waits comes first' "A.ids() === '$wait,$work'" 8
check 'its row is amber' "A.row($wait).status === 'waiting' && A.row($wait).icon === 'dialog-question-symbolic'"
wait_check 'it shows the command the session asks about' \
    "A.row($wait).subtitle === 'lighthouse · Wants to run' && A.row($wait).detail === 'rm -rf build'"
check 'there is no Allow and no Deny' "A.row($wait).controls === undefined && A.row($wait).actions === undefined && A.row($wait).primary === undefined"
check 'the dot next to the clock is amber' \
    "visor.content.attention === 'waiting' && A.dot().visible && A.dot().has_style_class_name('waiting')"
check 'the chip: amber, most important' \
    "A.chip().text === 'Tide tables is waiting' && A.chip().tone === 'waiting' && A.chip().priority === 100"
check 'the island flashes with the amber chip' \
    "visor.notch.state === 'peek' && visor.content.getPeek().get_child_at_index(0).label_actor.text === A.chip().text && visor.content.getPeek().get_child_at_index(0).has_style_class_name('waiting')"

open_panel
check 'expanding shows the last message of the assistant, as plain text' \
    "(async () => { A.chevron('Tide tables').emit('clicked', 1); await A.wait(300); const label = A.message(); return label !== undefined && label.text === 'I will remove the old build first.' && !label.clutter_text.use_markup || (label ? label.text : 'no label'); })()"
check 'and says where to answer' "A.hint()?.text === 'Answer in the terminal or the app the session runs in.'"
check 'a session without a window of its own has no button' "A.show() === undefined"
check 'the time ticks while the panel is open' "A.mod().tickSource !== 0"
check 'and moves' "(async () => { const before = A.row($work).subtitle; await A.wait(2100); return A.row($work).subtitle !== before; })()"

fixture transcript "$(session_id "$wait")" "$project" 'result:call-1' 'say:The build folder is gone. Building again now.'
fixture session "$wait" --name 'Tide tables' --status busy
wait_check 'answered in the terminal: the row works again' \
    "A.row($wait).status === undefined && A.row($wait).detail === undefined && A.row($wait).subtitle.startsWith('lighthouse · Working')"
wait_check 'the dot and the chip are gone' "visor.content.attention === null && A.chip() === null && !A.dot().visible"
wait_check 'the expanded row follows the transcript' "A.message()?.text === 'The build folder is gone. Building again now.'" 8
check 'and the hint is gone' "A.hint() === undefined"
run "A.chevron('Tide tables').emit('clicked', 1)"

# --- other reasons to wait ---------------------------------------------------------

fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'input needed'
wait_check 'a question' "A.row($wait).status === 'waiting' && A.row($wait).subtitle === 'lighthouse · Has a question' && A.row($wait).detail === undefined"
check 'no flash while the panel is open, but the dot' "visor.notch.state === 'open' && visor.content.attention === 'waiting'"
fixture transcript "$(session_id "$wait")" "$project" 'write:call-2:/home/ada/code/lighthouse/tides.csv'
fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'permission prompt'
wait_check 'a file' "A.row($wait).subtitle === 'lighthouse · Wants to use a file' && A.row($wait).detail === '/home/ada/code/lighthouse/tides.csv'" 8
fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'a prompt of a later version'
wait_check 'a reason this version does not know still waits' "A.row($wait).status === 'waiting' && A.row($wait).subtitle === 'lighthouse · Waits for you' && A.row($wait).detail === undefined"
fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'dialog open'
wait_check 'a menu the user opened themselves is no reason to call them' \
    "A.row($wait)?.status !== 'waiting' && visor.content.attention === null && A.chip() === null"
close_panel

# --- the flash can be turned off -----------------------------------------------------

run 'A.wait(3200)'
gsettings set org.gnome.shell.extensions.visor-claude flash-on-waiting-sessions false
fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'permission prompt'
wait_check 'waiting again, with the flash turned off: the chip and the dot' "A.chip() !== null && visor.content.attention === 'waiting'"
run 'A.wait(400)'
check 'but the island stays as it was' "visor.notch.state !== 'peek'"
gsettings reset org.gnome.shell.extensions.visor-claude flash-on-waiting-sessions
fixture session "$wait" --name 'Tide tables' --status busy
wait_check 'works again' "A.chip() === null"

# --- transcripts ---------------------------------------------------------------------

long="$(stand_in)"
fixture transcript "$(session_id "$long")" "$project" 'ai-title:Charting the shoals' 'say:An old message, far up.' \
    'pad:400' 'prompt:Go on' 'say:Found in the last part of a long file.' 'sub:A subagent said this.' 'raw:{"type":"assistant","message":' 'raw:not json at all'
fixture session "$long" --status busy
open_panel
wait_check 'a session without a name is called after its project until its title is known' "A.row($long) !== undefined"
wait_check 'of a transcript of 400 kB only the end is read: the message is found' \
    "(async () => { A.chevron(A.row($long).title).emit('clicked', 1); await A.wait(300); return A.message()?.text === 'Found in the last part of a long file.' || A.message()?.text; })()" 8
check 'the title is out of reach, so the row has the name of the project, once' \
    "A.row($long).title === 'lighthouse' && A.row($long).subtitle.startsWith('Working')"
check 'the part that was read is no larger than the limit' \
    "(() => { const e = A.mod().watcher.entries.get($long); return e.transcript !== null && Number(e.stamp.split(':')[0]) > 400000 && e.tail.lastMessage.length < 601; })()"
run "A.chevron(A.row($long).title).emit('clicked', 1)"
kill "$long"
rm "$claude_dir/sessions/$long.json"
wait_check 'the session ends and removes its file: the row is gone' "A.row($long) === undefined"

moved="$(stand_in)"
fixture transcript "$(session_id "$moved")" /home/ada/code/started-here 'title:Buoy inventory' 'say:Counted eleven buoys.'
fixture session "$moved" --cwd /home/ada/code/moved-there --status busy
wait_check 'a session that changed its directory: the transcript is found in the project it began in' \
    "A.row($moved)?.title === 'Buoy inventory' && A.row($moved).subtitle.startsWith('moved-there · Working')" 8
none="$(stand_in)"
fixture session "$none" --cwd /home/ada/code/no-transcript --name-source derived --name 'no-transcript' --status busy
wait_check 'a session without a transcript has a row all the same' "A.row($none)?.title === 'no-transcript' && A.row($none).expand === undefined"
wait_check 'and it was looked for once, not again and again' "A.mod().watcher.entries.get($none).searched === true"

# --- "+ n more" ----------------------------------------------------------------------

wait_check 'four sessions: three rows and "+ 1 more"' "A.rows().length === 4 && A.row('more').title === '+ 1 more'"
run "A.row('more').activate()"
check 'the row shows all' "A.rows().length === 4 && A.row('more') === undefined"
close_panel
check 'closing the panel stops the tick and folds the list' "A.mod().tickSource === 0 && A.mod().showAll === false && A.row('more') !== undefined"
kill "$moved" "$none"
rm "$claude_dir/sessions/$moved.json" "$claude_dir/sessions/$none.json"
wait_check 'two of them end' "A.ids() === '$wait,$work'"

# --- a session finishes ----------------------------------------------------------------

fixture session "$wait" --name 'Tide tables' --status idle --status-ago 116
wait_check 'a session that finishes gets a check' \
    "A.row($wait)?.status === 'done' && A.row($wait).icon === 'object-select-symbolic' && A.row($wait).subtitle === 'lighthouse · Done' && A.mod().expirySource !== 0"
check 'the finished one comes after the working one' "A.ids() === '$work,$wait'"
wait_check 'and is gone when its two minutes are over' "A.row($wait) === undefined" 8
fixture session "$wait" --name 'Tide tables' --status shell --status-ago 1
run 'A.wait(500)'
check 'written again while it rests, it does not come back' "A.row($wait) === undefined"
fixture session "$wait" --name 'Tide tables' --status busy
wait_check 'it works again: a row again' "A.row($wait)?.status === undefined && A.ids() === '$wait,$work'"

# --- a file caught half written ----------------------------------------------------------

fixture session "$work" --raw ''
run 'A.wait(500)'
check 'an empty file, as it is for a moment while it is written, keeps the row' "A.row($work)?.title === 'Harbour map'"
fixture session "$work" --raw '{"pid": '
run 'A.wait(500)'
check 'and so does half a file' "A.row($work)?.title === 'Harbour map'"
fixture session "$work" --name 'Harbour map, second draft' --status busy --status-ago 30
wait_check 'the whole file is read again' "A.row($work).title === 'Harbour map, second draft'"

# --- the window of a session ---------------------------------------------------------------

window_out="$HOME/window.out"
gjs -m "$repo/tests/shell/window.js" 'Quay terminal' >"$window_out" 2>/dev/null &
window_pid=$!
shell_wait_for "global.get_window_actors().some(a => a.meta_window.title === 'Quay terminal')" 20
for _ in $(seq 1 50); do [[ -s "$window_out" ]] && break; sleep 0.1; done
inwin="$(head -n 1 "$window_out")"
gjs -m "$repo/tests/shell/window.js" 'Other window' >/dev/null 2>&1 &
other_window=$!
shell_wait_for "global.get_window_actors().some(a => a.meta_window.title === 'Other window')" 20
shell_wait_for "A.focus() === 'Other window'" 5 || true
fixture transcript "$(session_id "$inwin")" "$project" 'prompt:Paint the quay' 'bash:call-9:make paint'
fixture session "$inwin" --name 'Quay' --status waiting --waiting-for 'permission prompt'
wait_check 'a session started from a window: its row offers to show it' \
    "A.row($inwin)?.primary?.label === 'Show' && A.row($inwin).primary.style === 'primary'" 8
check 'the process above it is known' "A.mod().watcher.ancestorsOf($inwin)[0] === $window_pid"
open_panel
check 'expanded it says where to answer and has no second button' \
    "(async () => { A.chevron('Quay').emit('clicked', 1); await A.wait(300); return A.hint() !== undefined && A.show() === undefined; })()"
run "A.row($inwin).primary.run()"
wait_check 'the button brings that window to the front and closes the panel' "A.focus() === 'Quay terminal' && visor.notch.state !== 'open'"
fixture session "$inwin" --name 'Quay' --status busy
wait_check 'the session works again: no button in the row' "A.row($inwin).status === undefined && A.row($inwin).primary === undefined"
run "Main.activateWindow(global.get_window_actors().find(a => a.meta_window.title === 'Other window').meta_window)"
shell_wait_for "A.focus() === 'Other window'" 5
open_panel
wait_check 'but in the expanded row, which is still open' "A.show()?.label_actor.text === 'Show window' && A.hint() === undefined"
run "A.show().emit('clicked', 1)"
wait_check 'which shows the window as well' "A.focus() === 'Quay terminal' && visor.notch.state !== 'open'"
open_panel
check 'the panel open again: the button is still there' "A.show() !== undefined"
kill "$window_pid" 2>/dev/null || true
wait_check 'the window closes while the panel is open: nothing to show any more' "A.row($inwin) === undefined || A.show() === undefined" 8
close_panel
rm -f "$claude_dir/sessions/$inwin.json"
wait_check 'and the session ends' "A.row($inwin) === undefined" 8

gjs -m "$repo/tests/shell/window.js" 'First tab' 'Second tab' >"$window_out.two" 2>/dev/null &
two_pid=$!
shell_wait_for "global.get_window_actors().filter(a => a.meta_window.get_pid() === $two_pid).length === 2" 20
for _ in $(seq 1 50); do [[ -s "$window_out.two" ]] && break; sleep 0.1; done
intwo="$(head -n 1 "$window_out.two")"
fixture session "$intwo" --name 'One of two' --status waiting --waiting-for 'input needed'
wait_check 'a terminal with two windows in one process: the session has a row' "A.row($intwo)?.status === 'waiting'" 8
run 'A.wait(600)'
check 'but no button, because nothing tells which window it is' \
    "A.mod().watcher.ancestorsOf($intwo)[0] === $two_pid && A.row($intwo).primary === undefined"
kill "$two_pid" "$other_window" 2>/dev/null || true
rm -f "$claude_dir/sessions/$intwo.json"
wait_check 'gone again' "A.row($intwo) === undefined" 8

# --- turned off ------------------------------------------------------------------------------

fixture session "$wait" --name 'Tide tables' --status waiting --waiting-for 'permission prompt'
wait_check 'a session waits' "visor.content.attention === 'waiting'"
run "visor.content.registry.setEnabled('claude', false)"
check 'disable stops the monitor and removes every source' \
    "(() => { const m = A.mod(); return m.watcher === null && m.tickSource === 0 && m.expirySource === 0 && m.aliveSource === 0 && A.rows().length === 0 && A.chip() === null && visor.content.attention === null; })()"
run "visor.content.registry.setEnabled('claude', true)"
wait_check 'enable reads the sessions again' "A.ids() === '$wait,$work' && visor.content.attention === 'waiting'" 8

rm -r "$claude_dir/sessions"
wait_check 'the folder of the sessions goes: every row with it' "A.rows().length === 0 && A.chip() === null" 8
fixture session "$work" --name 'Harbour map' --status busy
wait_check 'and comes back: the session is found again' "A.ids() === '$work'" 8

# --- private ------------------------------------------------------------------------------------

said='remove the old build|build folder is gone|last part of a long file|Counted eleven|old message|subagent said|rm -rf build|make paint|tides\.csv'
if grep -qE "$said" "$HOME/shell.log"; then
    echo 'FAIL  something of a transcript is in the log of the shell'
    fail=1
else
    echo 'ok    nothing of a transcript is in the log of the shell'
fi
if dconf dump / | grep -qE "$said|Tide tables|Harbour map"; then
    echo 'FAIL  something of a session is in dconf'
    fail=1
else
    echo 'ok    nothing of a session is in dconf'
fi
build="$HOME/.local/share/gnome-shell/extensions/$uuid"
if grep -rnE 'Soup|\.http\b|fetch\(|WebSocket|Socket|XMLHttpRequest' "$build" --include='*.js'; then
    echo 'FAIL  the code of the module knows a way to the network'
    fail=1
else
    echo 'ok    no line of the module makes a network request'
fi
if grep -rnE 'replace_contents|replace_async|replace_readwrite|\.replace\(null|create_async|create_readwrite|append_to|make_directory|delete_async|\.delete\((null|cancellable)|\.trash|set_contents|move_async|copy_async|OutputStream|Subprocess|spawn' "$build" --include='*.js'; then
    echo 'FAIL  the code of the module can write a file or start a process'
    fail=1
else
    echo 'ok    no line of the module writes a file or starts a process'
fi
finish
