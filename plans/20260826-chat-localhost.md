# Chat localhost recovery

## Goal

Allow the local editor URL printed by the development server (`http://localhost:3001`) to use the local API, so Agent chat can connect and send messages.

## Changes

- Accept the `localhost` loopback hostname on the configured web port in the API origin check.
- Preserve rejection of non-loopback hosts, HTTPS origins, credentials, paths, and mismatched ports.
- Cover the allowed and rejected origin cases with unit tests.

## Verification

- Run the origin unit tests and the full unit test suite.
- Run the production build.
- Open the app through `localhost` and verify Agent connectivity and an existing completed turn in the browser.
