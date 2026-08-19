# `@webai/openai-conformance-test`

Points at a server claiming to speak the OpenAI-compatible Chat Completions protocol and reports which parts of that protocol the server actually honours.

It does not grade whether an answer is a good answer. A model that replies with something unhelpful still passes, as long as the protocol was followed. Measuring the quality of an answer is a different job, and mixing the two makes both harder to read.

## Running it

```sh
npx tsx src/cli.ts --model llm_llama3_2_1b_full --profile full
```

Without cloning this repository:

```sh
npx webai-at-home openai_conformance_test --model llm_llama3_2_1b_full --profile full
```

## Options

- `-m, --model <name>` — the model identifier to ask for. Required.
- `-u, --base_url <url>` — the endpoint to test. Defaults to `http://localhost:8788/v1`, which is `consumer_openai`.
- `-p, --profile <name>` — `core`, `streaming`, `tools`, `parameters`, `structured_output`, `sdk`, `agent`, or `full`.
- `-g, --group <name>` and `-t, --test <id...>` — run part of a profile.
- `-f, --format <name>` — `text`, `json`, `markdown`, or `junit`.
- `-o, --output <path>` — write the report to a file instead of the terminal.
- `-r, --repeats <count>` — how many times a test that samples the model repeats before it decides.
- `--verbose` — print the measurement behind a passing test as well.
- `--ci` — turn off colouring and progress lines.

Exit code `0` when nothing failed, `1` when a test failed, `2` when the run itself could not start. `--ci` never changes which of these is returned.

## What a result means

| Verdict | Meaning |
| --- | --- |
| `PASS` | The protocol was followed. |
| `FAIL` | The endpoint claims to support this and behaves incorrectly. |
| `SKIP` | The endpoint said plainly that it does not support this. Left out of the compatibility percentage, because nothing was measured. |
| `WARN` | Correct, but in a way that may still break a client — a stream that arrives in one piece, or JSON wrapped in a code fence. |

A refusal is never a failure. An endpoint that says "I cannot do this" is behaving better than one that accepts the request and quietly ignores part of it.

This is also why the report prints a status for each capability rather than only one percentage: a refusal is left out of the denominator, so a server scores higher by declining to do more. The percentage alone would rank a cautious server above a capable one.

## Results for this project's own server

[`docs/openai_api_conformance.md`](../../docs/openai_api_conformance.md) records what this found when pointed at `consumer_openai` and at the local model server it forwards to.

## Testing

```sh
npm test
```

Every test starts its own local HTTP server standing in for an OpenAI-compatible endpoint, so the suite needs no cluster and no local model server.
