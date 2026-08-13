# Directory Context: `/packages/gateway/src/connection`

## Purpose

Accepts a connection, keeps it alive, checks every arriving frame before anything acts on it, and answers every HTTP request the gateway serves.

## Key Exports & Entry Points

- `connection_hub.ts`: `ConnectionHub`, which holds every open connection and sends gateway messages over them.
- `websocket_router.ts`: `WebsocketRouter`, which checks every arriving frame before anything acts on it.
- `websocket_heartbeat.ts`: `WebsocketHeartbeat`, which pings every open connection so an idle one is not silently dropped.
- `http_routes.ts`: `HttpRoutes`, which answers every HTTP request the gateway serves, including `pageRoutes`.

## Rules

- `WebsocketRouter` validates a frame against the envelope and message shapes from `@webai/protocol` before handing it to `task/` or `accounting/`; nothing downstream re-checks a frame's shape.
- A new browser page is registered here in the `pageRoutes` table of `http_routes.ts`, alongside its entry in [`vite.config.ts`](../../vite.config.ts) and its own directory under `web/`.
- `ConnectionHub` is the only place that writes to an open connection; `task/` and `accounting/` hand it a message rather than writing to a socket themselves.

## Background

- The three-part registration a new browser page needs is explained on the package's own [`CONTEXT.md`](../../CONTEXT.md).
