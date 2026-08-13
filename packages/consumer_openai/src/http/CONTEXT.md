# Directory Context: `/packages/consumer_openai/src/http`

## Purpose

The two HTTP routes this server answers, and the recording of each request and answer for later reading.

## Key Exports & Entry Points

- `openai_routes.ts`: `OpenaiRoutes`, the endpoints this server answers — `/v1/models` and `/v1/chat/completions`.
- `curl_style_transaction_logger.ts`: `CurlStyleTransactionLogger`, which writes one `curl -v`-style block per HTTP transaction.

## Rules

- `OpenaiRoutes` builds a request and reads a response only through `../api/`; it never reads an OpenAI request field or writes a response field by hand.
- A generation control the chosen model cannot honour is refused here with HTTP 400 and the code `unhonourable_generation_control`, never dropped silently.
- A value the OpenAI Chat Completions interface has no field for travels in an `X-Webai-*` response header, or not at all — never as an added member of a response body.

## Background

- The header and refusal rules come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and milestone 4 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
