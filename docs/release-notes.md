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
