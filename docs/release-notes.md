# Release notes

## Codex app-server migration

Weave Chat now uses Codex app-server Threads as its only conversation data source.

- Legacy `.weave/chat.json` data is deleted at startup and is not imported.
- Threads created by older Weave builds are not added to the new Thread list.
- Threads created by other Codex clients are neither listed nor modified.
- `.weave/deck.json`, `.weave/current-buffer.json`, slide HTML, and git history remain unchanged by the Chat migration.

New Weave Threads carry a durable `Weave · ` name marker in addition to the app-server
`threadSource` value. Weave uses the marker because Codex CLI 0.145.0 does not include
`threadSource` in `thread/list` results after a process restart.
# 2026-08-02 — Editing, quality, and delivery foundations

- Added recursive Row, Column, and Grid blocks with schema-backed style tokens and a functional inspector.
- Added accessible direct-edit states, IME-safe commit/cancel, focus affordances, shortcuts, and Undo/Redo.
- Added complete slide management: rename, duplicate, reorder, delete, notes, and a local reusable slide library.
- Added real zoom controls, height-aware fit, manual panning, collapsible inspector, and intermediate viewport layouts.
- Added deck quality and content-policy diagnostics with a navigable Quality panel and save/export gates.
- Added presenter mode and a self-contained offline multi-slide HTML export.
- Added revision-guarded transactional persistence, generated-slide cleanup, safe history restore commits, and idempotent saves.
- Added reconnect backoff/manual recovery and richer Agent context envelopes.
- Bounded expensive code/log/navigation rendering for large projects.
