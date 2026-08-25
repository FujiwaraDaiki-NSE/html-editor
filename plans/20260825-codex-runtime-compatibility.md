# Codex runtime compatibility plan

## Goal

Keep Weave connected across routine Codex CLI upgrades by treating a generated-binding version mismatch as a warning and using the required app-server initialization handshake as the runtime compatibility check.

## Work

1. Preserve generated and running CLI version information without marking a mismatch as incompatible before connection.
2. Start app-server and run `initialize`; report incompatibility only when the runtime handshake fails.
3. Keep `experimentalApi` disabled so Weave stays on the documented stable API surface.
4. Add focused tests for mismatch warnings, successful initialization across versions, and failed initialization.
5. Update developer documentation to describe the runtime-first compatibility policy and the type-generation review workflow.
6. Run lint, build, tests, and a local API/Codex readiness check against the mismatched checked-in bindings.
7. Review, commit, merge into the working branch, and remove the temporary worktree branch.

## Done criteria

- A CLI/generated-version mismatch no longer prevents app-server startup.
- Successful `initialize` makes the service ready even when versions differ.
- Failed `initialize` produces an actionable incompatible connection state.
- The local API reports `codex: true` with the current CLI while the worktree still carries the older generated version marker.

## Verification

- `npm run lint`: passed.
- `npm test`: build and all 149 tests passed.
- Mismatched runtime check: generated `0.146.0` with CLI `0.149.1` completed the handshake; `/healthz` reported `codex: true` and `/api/state` reported `connected`.
- `npm run codex:check`: reported the expected protocol differences without changing checked-in generated files.
