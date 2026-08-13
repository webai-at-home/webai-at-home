# Directory Context: `/packages/consumer_cli/src/gateway_connection`

## Purpose

Holds a consumer's connection to the central gateway, an observer's connection, and the session that connects as an observer and resolves once there is something to show.

## Key Exports & Entry Points

- `consumer_client.ts`: `ConsumerClient`, holding a consumer's connection to the central gateway. Reused by `@webai/consumer-openai`.
- `observer_client.ts`: `ObserverClient`, holding an observer's connection to the central gateway.
- `gateway_session.ts`: `GatewaySession`, which connects as an observer and resolves once there is something to show.

## Rules

- `ConsumerClient` is exported from this package's `src/index.ts` as `@webai/consumer-cli`'s one public symbol besides `TaskInputFactory`; nothing else in this folder is meant for another package to import.
- Message shapes come from `@webai/protocol` and are never restated here.

## Background

- `@webai/consumer-openai` reuses `ConsumerClient` rather than speaking the gateway protocol itself; see [`packages/consumer_openai`](../../../consumer_openai/CONTEXT.md).
