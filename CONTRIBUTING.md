# Contributing to the rownative worker

Thank you for your interest in contributing. This document describes how to propose changes, run tests, and open pull requests for the Cloudflare Worker backend.

## Getting started

1. Fork the [rownative/worker](https://github.com/rownative/worker) repository
2. Clone your fork and install dependencies:

   ```bash
   npm install
   ```

3. Run the test suite to ensure everything passes:

   ```bash
   npm test
   ```

## Development workflow

- Create a branch for your work (e.g. `fix/oauth-state`, `feat/new-endpoint`)
- Make your changes
- Add or update tests for new behavior
- Run `npm test` before committing
- Push to your fork and open a pull request against `develop` (or `main`, depending on project convention)

## Test suite

The worker uses [Vitest](https://vitest.dev) with the [Cloudflare Workers Vitest pool](https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-pool-workers/README.md). Tests run in a Miniflare environment that mimics the production Worker runtime.

- **OAuth tests** (`test/index.spec.ts`) — cover authorize, callback, state validation, and the iOS KV fallback
- **KML tests** (`test/kml-to-course.spec.ts`) — cover KML parsing and course conversion

Run a specific test file:

```bash
npx vitest run test/index.spec.ts
```

## Code style

- Use TypeScript
- Follow existing patterns in the codebase
- Prefer clear, readable code over clever optimizations

## Areas to contribute

- **Bug fixes** — OAuth flow, API edge cases, KML parsing
- **API improvements** — New endpoints, clearer error messages, better validation
- **Tests** — Improve coverage or add integration-style tests
- **Documentation** — README, inline docs, or CONTRIBUTING improvements

## Pull request guidelines

1. **Scope** — Keep PRs focused. Large changes are easier to review when split into smaller ones.
2. **Tests** — New behavior should have tests. Fixes for regressions should include a test that would have caught the bug.
3. **Description** — Explain the problem and your approach. Reference any related issues.

## Reporting issues

Open an issue at [github.com/rownative/worker/issues](https://github.com/rownative/worker/issues) for:

- OAuth or authentication bugs
- API errors or unexpected behavior
- Questions about the codebase or deployment

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project. See the repository root for license details.
