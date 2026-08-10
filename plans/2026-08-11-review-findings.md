# Review findings fixes

## Goal

Fix the three review findings without losing editor state or allowing project operations to cross repository boundaries.

## Plan

- [ ] Guard project switching and creation when browser-only edits are unsaved.
- [ ] Remove asynchronous mutation of the shared current-project root and bind writes to an explicit root.
- [ ] Insert new-project titles with a replacement callback so `$` sequences remain literal.
- [ ] Add regression tests and run test, typecheck, and lint verification.

