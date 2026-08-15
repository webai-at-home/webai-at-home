# Directory Context: `/packages/gateway/src/connection`

## Purpose

Accepts a connection, keeps it alive, checks every arriving frame before anything acts on it, and answers every HTTP request the gateway serves.

## Key Exports & Entry Points

- `connection_hub.ts`: `ConnectionHub`, which holds every open connection and sends gateway messages over them.
- `websocket_router.ts`: `WebsocketRouter`, which checks every arriving frame before anything acts on it.
- `websocket_heartbeat.ts`: `WebsocketHeartbeat`, which pings every open connection so an idle one is not silently dropped.
- `http_routes.ts`: `HttpRoutes`, which answers every HTTP request the gateway serves, including `pageRoutes`.
- `client_ip_address.ts`: `ClientIpAddress`, which reads the address a connection was opened from out of the HTTP request that carried the WebSocket upgrade.

## Rules

- `WebsocketRouter` validates a frame against the envelope and message shapes from `@webai/protocol` before handing it to `task/` or `accounting/`; nothing downstream re-checks a frame's shape.
- A new browser page is registered here in the `pageRoutes` table of `http_routes.ts`, alongside its entry in [`vite.config.ts`](../../vite.config.ts) and its own directory under `web/`.
- `ConnectionHub` is the only place that writes to an open connection; `task/` and `accounting/` hand it a message rather than writing to a socket themselves.
- The address a connection came from is read only in `WebsocketRouter.acceptConnection`, where the HTTP upgrade request still exists, and is kept in `ConnectionHub.ipAddressMap` until the connection closes. Nothing reads an address out of a message a device sent.
- `ClientIpAddress` believes the `x-forwarded-for` header only when the gateway was started with `--trust-reverse-proxy`, because any client can write that header.

## Background

- The three-part registration a new browser page needs is explained on the package's own [`CONTEXT.md`](../../CONTEXT.md).
- The address of a connection is recorded so `consumer_cli status` can show it; see [issue #183](https://github.com/webai-at-home/webai-at-home/issues/183).
