# Dynamic development port plan

## Goal

Allow the local Weave development UI to use the local API when Vite starts on a port other than 3000, without accepting requests from non-local origins.

## Work

1. Find the first available web port from 3000 before starting the development processes.
2. Pass that port to Vite with `--strictPort` and to the local API as `WEAVE_WEB_PORT`.
3. Replace the fixed development-origin allowlist with validation for the configured `127.0.0.1` HTTP port.
4. Add focused unit tests for port selection and allowed/rejected origins.
5. Update the startup documentation to describe the next-available-port behavior.
6. Run unit, lint, build, and local port-conflict UI checks.
7. Review the implementation, commit it, merge it into the working branch, and remove the temporary worktree branch.

## Done criteria

- The `127.0.0.1` development origin works on the selected port.
- Non-loopback, malformed, credential-bearing, unsupported-protocol, and wrong-port origins remain rejected.
- The Vite UI and local API receive the same selected port configuration.
- The UI loads and reaches the local API when port 3000 is occupied.

## Verification

- `npm run lint`
- `npm test` (build and 142 tests)
- Browser load on port 3001 while port 3000 was occupied
- API CORS: selected origin returned 200; wrong-port origin returned 403
