# Directory Context: `/packages/consumer_openai/src/http`

## Purpose

The HTTP routes this server answers, in both of the OpenAI interfaces it serves, and the recording of each request and answer for later reading.

## Key Exports & Entry Points

- `openai_routes.ts`: `OpenaiRoutes`, the endpoints this server answers — `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- `responses_stream_writer.ts`: `ResponsesStreamWriter`, which writes one streamed `/v1/responses` answer as named server-sent events.
- `curl_style_transaction_logger.ts`: `CurlStyleTransactionLogger`, which writes one `curl -v`-style block per HTTP transaction.

## Rules

- `OpenaiRoutes` builds a request and reads a response only through `../api/`; it never reads an OpenAI request field or writes a response field by hand.
- A generation control the chosen model cannot honour is refused here with HTTP 400 and the code `unhonourable_generation_control`, never dropped silently.
- `/v1/models` lists the models the cluster can run right now, read through `../libs/model_availability.ts`, never the whole catalogue; a central gateway that cannot be asked is HTTP 503, never an empty list.
- A value the OpenAI Chat Completions interface has no field for travels in an `X-Webai-*` response header, or not at all — never as an added member of a response body.
- `/v1/responses` runs the same task as `/v1/chat/completions`: it translates through `../api/responses_translator.ts` and then uses the same builders and the same `ClusterTaskRunner`. A second way of reaching the cluster is what must not appear here.
- The names, the order, and the fields of the events `ResponsesStreamWriter` writes are the recorded traffic of a server the Codex command-line program accepts, and are changed only against a new recording.
- A tool kind this cluster cannot run, such as `web_search` or `namespace`, is carried nowhere and named in the `X-Webai-Unsupported-Tool-Kinds` response header. A `function` tool is never dropped: it is refused when the model cannot read one.

## Background

- The header and refusal rules come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and milestone 4 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
- The `/v1/models` rule comes from [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
- `/v1/responses` comes from [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214), and its shapes are the traffic recorded in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).
