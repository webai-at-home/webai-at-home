# OpenAI Compatibility Report

## Summary

- Passed: 26
- Failed: 5
- Skipped: 1
- Warned: 0

Compatibility: 83.9%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-17T14:20:10.727Z
- Endpoint: `http://localhost:1234/v1`
- Model: `google/gemma-4-e2b`

### Command Line

```bash
openai_conformance_test --model google/gemma-4-e2b --base_url http://localhost:1234/v1 --profile full --format markdown --output data/reports/lmstudio_gemma_4_e2b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | google/gemma-4-e2b |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/reports/lmstudio_gemma_4_e2b.md |
| `--base_url` | http://localhost:1234/v1 |
| `--api_key` | no-key-required |
| `--timeout_ms` | 600000 |
| `--format` | markdown |

## Models

| Test | Result | Detail |
| --- | --- | --- |
| `models.list` | ✅ |  |

## Chat Completions

| Test | Result | Detail |
| --- | --- | --- |
| `chat.basic` | ✅ |  |
| `chat.system_message` | ✅ |  |
| `chat.multi_turn` | ✅ |  |

## Usage

| Test | Result | Detail |
| --- | --- | --- |
| `usage.present` | ✅ |  |
| `usage.total_is_sum` | ✅ |  |

## Errors

| Test | Result | Detail |
| --- | --- | --- |
| `errors.unknown_model` | ✅ |  |
| `errors.malformed_json` | ✅ |  |
| `errors.missing_messages` | ❌ | HTTP 400 but no "error" object: {"error":"'messages' field is required"} |

## Streaming

| Test | Result | Detail |
| --- | --- | --- |
| `streaming.headers` | ✅ |  |
| `streaming.basic` | ✅ |  |
| `streaming.content_concatenates` | ✅ |  |
| `streaming.finish_reason` | ✅ |  |
| `streaming.done` | ✅ |  |
| `streaming.timing` | ✅ |  |

## Tool Calling

| Test | Result | Detail |
| --- | --- | --- |
| `tools.generates_a_call` | ✅ |  |
| `tools.generates_a_call_when_forced` | ✅ |  |
| `tools.fills_in_the_arguments` | ✅ |  |
| `tools.chooses_among_several_tools` | ✅ |  |
| `tools.reads_a_tool_result_back` | ✅ |  |
| `tools.answers_without_a_call_when_none_is_needed` | ✅ |  |

## Parameters

| Test | Result | Detail |
| --- | --- | --- |
| `parameters.temperature` | ✅ |  |
| `parameters.top_p` | ❌ | the answers still varied at temperature 1.6 with top_p 0.01, so the value changed nothing |
| `parameters.max_completion_tokens` | ❌ | the endpoint returned no answer text |
| `parameters.stop` | ❌ | the endpoint returned no answer text |
| `parameters.seed` | ❌ | seed 42 gave two different answers, so the seed decided nothing |

## Structured Output

| Test | Result | Detail |
| --- | --- | --- |
| `structured_output.json_object` | ⊘ | json_object is not supported: HTTP 400, {"error":"'response_format.type' must be 'json_schema' or 'text'"} |
| `structured_output.json_schema` | ✅ |  |

## OpenAI Node.js Package

| Test | Result | Detail |
| --- | --- | --- |
| `sdk.node.models_list` | ✅ |  |
| `sdk.node.basic` | ✅ |  |
| `sdk.node.streaming` | ✅ |  |
| `sdk.node.tools` | ✅ |  |
