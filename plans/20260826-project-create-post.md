# Restore project creation

## Goal

Allow `POST /api/projects` while preserving `GET /api/projects` and the existing method guards for every other local API route.

## Changes

- Declare both allowed methods for the shared projects collection route.
- Make the method guard validate against all declared methods and return the complete `Allow` header.
- Test the route decision directly for the dual-method route, its `Allow` value, and existing single-method routes.

## Verification

- Run the production build, type check, lint, and full test suite.
- Verify an empty `POST /api/projects` reaches payload validation instead of returning 405.
- Create a project from the UI and verify it opens successfully.
