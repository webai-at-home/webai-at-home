# OpenAI Compatibility Report

## Summary

- Passed: 44
- Failed: 0
- Skipped: 0
- Warned: 0

Compatibility: 100.0%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-19T06:44:01.805Z
- Endpoint: `http://localhost:11434/v1`
- Model: `gemma4:e2b`

### Command Line

```bash
openai_test conformance --base_url http://localhost:11434/v1 --model gemma4:e2b --profile full --format markdown --output data/conformance_reports/ollama_gemma4_e2b.conformance_report.md -v
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | gemma4:e2b |
| `--profile` | full |
| `--repeats` | 3 |
| `--thinking` | off |
| `--output` | data/conformance_reports/ollama_gemma4_e2b.conformance_report.md |
| `--verbose` | true |
| `--base_url` | http://localhost:11434/v1 |
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
| `errors.missing_messages` | ✅ |  |

## History

| Test | Result | Detail |
| --- | --- | --- |
| `history.accepted` | ✅ |  |
| `history.recalled` | ✅ |  |

## Streaming

| Test | Result | Detail |
| --- | --- | --- |
| `streaming.headers` | ✅ |  |
| `streaming.basic` | ✅ |  |
| `streaming.content_concatenates` | ✅ |  |
| `streaming.finish_reason` | ✅ |  |
| `streaming.done` | ✅ |  |
| `streaming.timing` | ✅ |  |

## Structured Output

| Test | Result | Detail |
| --- | --- | --- |
| `structured_output.json_object` | ✅ |  |
| `structured_output.json_schema` | ✅ |  |

## OpenAI Node.js Package

| Test | Result | Detail |
| --- | --- | --- |
| `sdk.node.models_list` | ✅ |  |
| `sdk.node.basic` | ✅ |  |
| `sdk.node.streaming` | ✅ |  |
| `sdk.node.tools` | ✅ |  |

## Tool Calling

| Test | Result | Detail |
| --- | --- | --- |
| `tools.generates_a_call` (stream off) | ✅ |  |
| `tools.generates_a_call` (stream on) | ✅ |  |
| `tools.generates_a_call_when_forced` (stream off) | ✅ |  |
| `tools.generates_a_call_when_forced` (stream on) | ✅ |  |
| `tools.fills_in_the_arguments` (stream off) | ✅ |  |
| `tools.fills_in_the_arguments` (stream on) | ✅ |  |
| `tools.chooses_among_several_tools` (stream off) | ✅ |  |
| `tools.chooses_among_several_tools` (stream on) | ✅ |  |
| `tools.reads_a_tool_result_back` (stream off) | ✅ |  |
| `tools.reads_a_tool_result_back` (stream on) | ✅ |  |
| `tools.answers_without_a_call_when_none_is_needed` (stream off) | ✅ |  |
| `tools.answers_without_a_call_when_none_is_needed` (stream on) | ✅ |  |

## Parameters

| Test | Result | Detail |
| --- | --- | --- |
| `parameters.temperature` (stream off) | ✅ |  |
| `parameters.temperature` (stream on) | ✅ |  |
| `parameters.top_p` (stream off) | ✅ |  |
| `parameters.top_p` (stream on) | ✅ |  |
| `parameters.max_completion_tokens` (stream off) | ✅ |  |
| `parameters.max_completion_tokens` (stream on) | ✅ |  |
| `parameters.stop` (stream off) | ✅ |  |
| `parameters.stop` (stream on) | ✅ |  |
| `parameters.seed` (stream off) | ✅ |  |
| `parameters.seed` (stream on) | ✅ |  |
