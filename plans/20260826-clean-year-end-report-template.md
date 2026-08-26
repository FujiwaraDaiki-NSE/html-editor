# Clean year-end report templates

## Goal

Keep the year-end report variants as empty frames containing only their source-derived SVG and title/content slots. Remove placeholder furniture and cover dummy fields that should be supplied by slide content.

## Changes

- Simplify `reportTemplate` to the shared frame arguments and remove furniture/cover placeholder insertion.
- Update template and application tests to verify those dummy texts and elements are absent while SVG geometry remains present.
- Remove report-specific page-number assertions and tests.

## Verification

- Run `npm run test:unit`.
