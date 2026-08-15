# Directory Context: `/packages/protocol/src/message`

## Purpose

Every message that travels between a client and the central gateway, the wrapper each one is sent in, the protocol version that wrapper carries, and the recording of both to a log file.

## Key Exports & Entry Points

- `client_message.ts`: `ClientMessage`, every message a client may send the gateway.
- `gateway_message.ts`: `GatewayMessage`, every message the gateway may send a client, and `ProtocolErrorCode`, the errors it answers with.
- `envelope_types.ts`: `protocolVersion`, `supportedProtocolVersions`, and the envelope schemas.
- `envelope.ts`: `Envelope`, which wraps a message for sending and reads a received wrapper.
- `message_logger.ts`: `MessageLogger` and `LogEntry`, the `.log_entry.jsonl` format. Also reachable as the `@webai/protocol/message_logger` subpath.
- `diagnostics.ts`: `DiagnosticEntry` and `DiagnosticsBatch`, what a worker browser page reports about the messages it saw.
- `departure.ts`: `Departure` and `departureContentType`, what a worker browser page sends as its tab is being closed.

## Rules

- A message is added to `client_message.ts` or to `gateway_message.ts`, never to both: the direction a message travels is part of what it is.
- `protocolVersion` is raised only together with `supportedProtocolVersions`, because a client and the gateway are never guaranteed to be built at the same time.
- Nothing here imports from `../task/`: a message carries a task shape by reference to that folder's types, and never redefines one.
- `departure.ts` states the content type a departure is sent with, because the gateway and the worker browser page must agree on a type a browser sends without asking permission first; neither side spells it out on its own.
- The `.log_entry.jsonl` format defined by `message_logger.ts` is read by [`packages/flow_viewer`](../../../flow_viewer/) and by `consumer_cli`'s `log_statistics`. Changing the format means changing both readers.

## Background

- The `@webai/protocol/message_logger` subpath exists so a reader of a log file does not have to load the whole package.
- The departure and its content type come from [issue #176](https://github.com/webai-at-home/webai-at-home/issues/176).
