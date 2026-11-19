# Where the sessions come from

Claude Code documents no way for another program to ask which sessions run and what they do. This module
reads two kinds of files Claude Code keeps for itself. **Neither format is documented, and either can change
with any release.** This page lists every field the module relies on, how it was found, and what happens
when a field is missing. The code is `src/sessions.ts` (all parsing, no I/O) and `src/watcher.ts` (reading).

Looked at on 2026-11-19 with **Claude Code 2.1.327** on Linux (`claude --version`), by reading the files of
a running session and the JavaScript inside the binary. The hooks reference
(<https://code.claude.com/docs/en/hooks>) was read the same day.

The folder is `~/.claude`, or the one `CLAUDE_CONFIG_DIR` names in the environment of GNOME Shell (a
variable set only in a shell profile does not reach GNOME Shell).

## 1. The session file of a process: `sessions/<pid>.json`

Every running Claude Code process writes one small JSON file, named after its pid, and writes it again when
its status or name changes. It removes the file when it ends. Next to it lies `<pid>.<hash>.key`, which the
module never opens.

| Field             | Used for                                                                                                                   | When it is missing or odd                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pid`             | Must be the number in the file name.                                                                                       | The file is ignored.                                                        |
| `sessionId`       | The file name of the transcript. Only letters, digits, `.`, `_`, `-` are accepted.                                         | The file is ignored.                                                        |
| `status`          | `busy` → working, `waiting` → see `waitingFor`, `idle` and `shell` → at rest (finished, see below).                        | Any other value: the file is ignored, the session has no row.               |
| `waitingFor`      | Why a `waiting` session waits, see the table below.                                                                        | Missing or unknown: "Waits for you", amber, without a detail.               |
| `statusUpdatedAt` | Milliseconds since 1970: since when it works (the running time) and when it finished (the two minutes).                    | Falls back to `updatedAt`; without both there is no time and no "Done" row. |
| `startedAt`       | An idle session whose status is less than 5 s younger than its start has not worked yet: no "Done" row.                    | The rule is skipped.                                                        |
| `cwd`             | The project name (last part of the path) and the folder of the transcript.                                                 | No project name; the transcript is searched for by session id.              |
| `name`            | The title of the row.                                                                                                      | The title of the transcript, else the project name.                         |
| `nameSource`      | `derived` means Claude Code made the name from the directory; it is not used as a title then.                              | The name is used.                                                           |
| `procStart`       | Start time of the process, compared with field 22 of `/proc/<pid>/stat` so that a reused pid is not taken for the session. | Any live process with that pid is believed.                                 |
| `spare`, `kind`   | `spare: true` (a process kept ready, without a conversation) and `kind: "daemon"` are not shown.                           | Shown.                                                                      |

In the binary the status values are the list `["busy","shell","idle","waiting"]`. `shell` is set where the
code picks between it and the status it had computed; from the code around it, it stands for a turn that is
over while a background command still runs. That reading is an inference, and the module treats it as idle.

`waitingFor` as Claude Code 2.1.327 writes it, and the groups it sorts the values into itself (the module
uses the same table):

| `waitingFor`        | Group in Claude Code | In Visor                                                              |
| ------------------- | -------------------- | --------------------------------------------------------------------- |
| `permission prompt` | permission           | amber, "Wants to run" / "Wants to use a file" / "Asks for permission" |
| `sandbox request`   | permission           | the same                                                              |
| `worker request`    | permission           | the same                                                              |
| `goal proposal`     | permission           | the same                                                              |
| `input needed`      | question             | amber, "Has a question"                                               |
| `dialog open`       | none                 | not waiting: a menu the user opened in the terminal themselves        |
| anything else       |                      | amber, "Waits for you"                                                |

Both ways of running Claude Code write the field: the terminal interface (from the dialog on top) and the
headless one that other programs drive (there `requires_action` becomes `waiting`, with `input needed` for
questions and `permission prompt` otherwise). So sessions started by an editor or by T3 Code show up too.

**A process that is gone.** A process that was killed leaves its file behind. Each file is therefore checked
against `/proc/<pid>/stat` when it is read, again when the panel opens, and every 30 seconds while a session
is shown as working or waiting.

**A file caught half written.** Claude Code writes the file in place, so for a moment it can be empty or cut
off. Text that is not a JSON object changes nothing: what was known stays until the file is whole again.

**When is a session "Done"?** When its status turns from `busy` or `waiting` to `idle`. The module remembers
that moment per process, so a session that is written again while it rests (a new name, a closed menu) does
not come back. For a session it sees for the first time, already idle, `statusUpdatedAt` is taken as the end
of the turn.

## 2. The transcript: `projects/<project>/<sessionId>.jsonl`

One JSON object per line. `<project>` is the working directory with every character that is no ASCII letter
or digit replaced by `-`; paths longer than 200 characters get a hash the module does not know, and a
session that changed its directory still writes to the project it began in. When the file is not where the
`cwd` says, the module looks through the project folders for `<sessionId>.jsonl`, once per session and
status.

Only the **last 256 kB** are read, asynchronously, and only when the session file changed, a moment later
again (the transcript is written after the status), when the panel opens, and every 3 seconds while the
panel is open and a session works. A file whose size and modification time are unchanged is not read
again. The first line of the part that was read is dropped, because it may be the rest of a longer one.
Lines that are not JSON, or not of a shape below, are skipped. Most lines of a transcript are of other
types (`attachment`, `api-request`, …) and are not even parsed.

| Line                                       | Fields                                                                                                                                              | Used for                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `type: "assistant"`                        | `message.content[]` with `type: "text"`, `text`                                                                                                     | The last message, shown when a row is expanded (one line, at most 600 characters). |
| `type: "assistant"`                        | `message.content[]` with `type: "tool_use"`, `id`, `name`, `input.command` / `input.file_path` / `input.notebook_path` / `input.path` / `input.url` | What a permission is about, see below.                                             |
| `type: "user"`                             | `message.content[]` with `type: "tool_result"`, `tool_use_id`                                                                                       | Which tool calls are answered already.                                             |
| `type: "user"` with anything else          | `message`                                                                                                                                           | Where the current turn begins.                                                     |
| `type: "custom-title"`, `type: "ai-title"` | `customTitle`, `aiTitle`                                                                                                                            | The title of a session without a `name`; the user's title wins.                    |
| any                                        | `isSidechain: true`, `isMeta: true`                                                                                                                 | Lines of subagents and notes that are not part of the conversation; skipped.       |

**What a permission is about.** The session file says _that_ a session waits for a permission, not for
what. The module shows a command or a path only when the current turn of the transcript has **exactly one**
tool call without a result, and that call is not `Agent` or `Task` (then a subagent asks, about something
the main transcript does not hold). With several calls open, or none in reach, the row says "Asks for
permission" and nothing more. This is a display aid; it is not what Claude Code asks, word for word, and
nothing can be allowed from it.

What is never done with a transcript: it is not logged, not copied, not sent anywhere, and nothing but the
fields above is kept in memory (the last message, cut to 600 characters, the title and the one command).

## 3. The window of a session

"Show window" walks up from the pid of the session through `/proc/<pid>/stat` (field 4, the parent) and
takes the nearest process that owns a normal window (`Meta.Window.get_pid()`). If that process has exactly
one window, it is the one. A terminal that keeps several windows in one process (GNOME Terminal, Ptyxis)
does not tell which window holds the session; then there is no button rather than a guess. Tabs cannot be
told apart at all: the window comes to the front, the tab stays what it was.

## 4. What was not used, and why

- **Hooks** (`Notification` with the matchers `permission_prompt`, `idle_prompt`, `elicitation_dialog`;
  `PermissionRequest`; `Stop`; `SessionStart`; `SessionEnd`) are the documented way to learn about these
  moments. They need an entry in `~/.claude/settings.json` and a script that writes the state somewhere.
  The session files already say the same without any setup, so the module installs no hook and never
  writes to `~/.claude`. If a later version of Claude Code drops `status` or `waitingFor`, hooks are the way
  to go; the module would then show nothing rather than something wrong (an unknown `status` is ignored).
- **Allow and Deny from the notch.** A `PermissionRequest` hook can answer a permission
  (`hookSpecificOutput.decision.behavior`), but only while it runs: the hook would have to block Claude Code
  and wait for a click in GNOME Shell, with a timeout, for every permission of every session, and a wrong
  match between a click and a request would allow a command nobody read. There is no supported way to answer
  a prompt that is already on screen. So the module answers nothing.
- **The socket in `messagingSocketPath`** and the `.key` file belong to the messaging between Claude Code
  sessions. The module does not connect to it.

## 5. If it stops working

`pnpm test` runs the parser against invented files in the shapes above. With a new version of Claude Code,
compare a real `sessions/<pid>.json` with the first table and the status values with the second; both are
in `src/sessions.ts` (`parseSessionFile`, `WAITING`).
