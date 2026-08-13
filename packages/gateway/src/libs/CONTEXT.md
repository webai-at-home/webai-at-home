# Directory Context: `/packages/gateway/src/libs`

## Purpose

The gateway's own command line options and environment variables, and the one small utility that does not belong to `connection/`, `task/`, `device/`, or `accounting/`.

## Key Exports & Entry Points

- `gateway_settings.ts`: `GatewaySettings`, the gateway's command line options, read once and typed, and `defaultDataDirectory`.
- `diagnostics_rate_limiter.ts`: `DiagnosticsRateLimiter`, which caps how many diagnostic entries one device may report.

## Rules

- Every new command line option or environment variable is added to `gateway_settings.ts` and documented in [`docs/environment_variables.md`](../../../../docs/environment_variables.md).
- A file lands here only once it is needed by more than one of `connection/`, `task/`, `device/`, or `accounting/`; a helper needed by one of those stays inside that folder instead.
- Nothing in this folder imports from `connection/`, `task/`, `device/`, or `accounting/`, so any of those four may depend on `libs/` without a cycle.

## Background

- The account file, ledger file, state file, and message log locations `gateway_settings.ts` reads all default to `~/.webai-at-home/gateway/`, from [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171).
