# Directory Context: `/packages/openai_conformance_test/src/clients`

## Purpose

The two ways this package reaches an endpoint under test, as section 37 of issue #181 requires: one raw, one through the official `openai` Node.js package.

## Key Exports & Entry Points

- `raw_http_client.ts`: `RawHttpClient`, `GET /models` and `POST /chat/completions` sent as raw JSON over `fetch`, reading back the HTTP status, headers, and body untouched.
- `openai_package_client.ts`: `OpenaiPackageClient`, a thin wrapper around `new OpenAI({ baseURL, apiKey, timeout })`.

## Rules

- `RawHttpClient` is the only file in this package that builds a request body or parses a response body by hand; everywhere else, a chat completion request goes through one of these two clients.
- Neither client retries a request or interprets a failure. A test reads the status and the body itself and decides the verdict; a client that guessed would hide the exact behaviour a conformance test exists to observe.

## Background

- Nothing here needs a longer reason than the rule itself gives.
