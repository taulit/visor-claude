#!/usr/bin/env python3
"""Writes invented Claude Code files into the HOME of the sandbox, for the shell
tests and the screenshots: session files as Claude Code 2.1.327 writes them
(see docs/data-source.md) and transcripts. Refuses to run anywhere else.

  fixture.py session PID [--status busy|idle|waiting|shell] [--waiting-for TEXT]
             [--name NAME] [--name-source user|derived] [--cwd DIR] [--id SESSION]
             [--status-ago SECONDS] [--started-ago SECONDS] [--proc-start TEXT]
             [--kind KIND] [--spare] [--raw TEXT]
  fixture.py transcript SESSION CWD ITEM...
      ITEM: prompt:TEXT  say:TEXT  sub:TEXT  title:TEXT  ai-title:TEXT
            bash:ID:COMMAND  write:ID:PATH  result:ID  pad:KILOBYTES  raw:TEXT
"""
import argparse
import json
import os
import re
import sys
import time

home = os.environ.get("HOME", "")
sandbox = os.environ.get("VISOR_SANDBOX", "")
if not sandbox or not home.startswith(sandbox + "/") or "visor-shell." not in home:
    sys.exit("fixture.py: HOME is not the sandbox of scripts/nested.sh; nothing written")
claude = os.path.join(home, ".claude")


def session(args):
    now = int(time.time() * 1000)
    path = os.path.join(claude, "sessions", f"{args.pid}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if args.raw is not None:
        with open(path, "w") as out:
            out.write(args.raw)
        return
    proc_start = args.proc_start
    if proc_start is None:
        with open(f"/proc/{args.pid}/stat") as stat:
            proc_start = stat.read().rsplit(")", 1)[1].split()[19]
    started = now - int(args.started_ago * 1000)
    changed = now - int(args.status_ago * 1000)
    record = {
        "pid": args.pid,
        "sessionId": args.id or f"00000000-0000-4000-8000-{args.pid:012d}",
        "cwd": args.cwd,
        "startedAt": started,
        "procStart": proc_start,
        "version": "2.1.327",
        "peerProtocol": 1,
        "kind": args.kind,
        "entrypoint": "cli",
        "status": args.status,
        "updatedAt": changed,
        "statusUpdatedAt": changed,
    }
    if args.name:
        record["name"] = args.name
        record["nameSource"] = args.name_source
        record["nameSince"] = started
    if args.waiting_for:
        record["waitingFor"] = args.waiting_for
    if args.spare:
        record["spare"] = True
    # In place, the way Claude Code writes it.
    with open(path, "w") as out:
        json.dump(record, out)


def transcript(args):
    directory = os.path.join(claude, "projects", re.sub(r"[^a-zA-Z0-9]", "-", args.cwd))
    os.makedirs(directory, exist_ok=True)
    count = 0

    def line(kind, **more):
        nonlocal count
        count += 1
        base = {
            "type": kind,
            "uuid": f"line-{time.time_ns()}-{count}",
            "sessionId": args.session,
            "isSidechain": False,
            "cwd": args.cwd,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "version": "2.1.327",
        }
        base.update(more)
        return json.dumps(base)

    def assistant(block, **more):
        return line("assistant", message={"role": "assistant", "content": [block]}, **more)

    out = []
    for item in args.items:
        kind, _, rest = item.partition(":")
        if kind == "prompt":
            out.append(line("user", message={"role": "user", "content": rest}))
        elif kind == "say":
            out.append(assistant({"type": "text", "text": rest}))
        elif kind == "sub":
            out.append(assistant({"type": "text", "text": rest}, isSidechain=True))
        elif kind == "title":
            out.append(json.dumps({"type": "custom-title", "customTitle": rest, "sessionId": args.session}))
        elif kind == "ai-title":
            out.append(json.dumps({"type": "ai-title", "aiTitle": rest, "sessionId": args.session}))
        elif kind in ("bash", "write"):
            call, _, value = rest.partition(":")
            name, data = ("Bash", {"command": value}) if kind == "bash" else ("Write", {"file_path": value, "content": "…"})
            out.append(assistant({"type": "tool_use", "id": call, "name": name, "input": data}))
        elif kind == "result":
            block = {"type": "tool_result", "tool_use_id": rest, "content": "ok"}
            out.append(line("user", message={"role": "user", "content": [block]}))
        elif kind == "pad":
            out.append(json.dumps({"type": "api-request-blob", "hash": "0", "message": "x" * (int(rest) * 1024)}))
        elif kind == "raw":
            out.append(rest)
        else:
            sys.exit(f"fixture.py: unknown item {item}")
    with open(os.path.join(directory, f"{args.session}.jsonl"), "a") as target:
        target.write("".join(entry + "\n" for entry in out))


parser = argparse.ArgumentParser()
commands = parser.add_subparsers(dest="command", required=True)
one = commands.add_parser("session")
one.add_argument("pid", type=int)
one.add_argument("--status", default="busy")
one.add_argument("--waiting-for")
one.add_argument("--name")
one.add_argument("--name-source", default="user")
one.add_argument("--cwd", default="/home/ada/code/lighthouse")
one.add_argument("--id")
one.add_argument("--status-ago", type=float, default=0)
one.add_argument("--started-ago", type=float, default=3600)
one.add_argument("--proc-start")
one.add_argument("--kind", default="interactive")
one.add_argument("--spare", action="store_true")
one.add_argument("--raw")
one.set_defaults(run=session)
two = commands.add_parser("transcript")
two.add_argument("session")
two.add_argument("cwd")
two.add_argument("items", nargs="+")
two.set_defaults(run=transcript)
parsed = parser.parse_args()
parsed.run(parsed)
