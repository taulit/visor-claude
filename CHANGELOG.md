# Changelog

## [0.1.0] - 2026-11-19

- First version: the Claude Code sessions of this machine as rows in Now (working, waiting, finished for two minutes), an amber row, a chip and a dot while a session waits for a permission or an answer, the last message when a row is expanded, and "Show window" for sessions whose window can be told.
- Reads `~/.claude/sessions/<pid>.json` and the end of the transcripts; no setup, no network request, nothing written. Built against Claude Code 2.1.327, see `docs/data-source.md`.
