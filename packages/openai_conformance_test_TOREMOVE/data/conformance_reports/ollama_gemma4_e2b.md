# OpenAI Compatibility Report

## Summary

- Passed: 30
- Failed: 2
- Skipped: 0
- Warned: 0

Compatibility: 93.8%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-17T14:14:04.617Z
- Endpoint: `http://localhost:11434/v1`
- Model: `gemma4:e2b`

### Command Line

```bash
openai_conformance_test --model gemma4:e2b --base_url http://localhost:11434/v1 --profile full --format markdown --output data/conformance_reports/ollama_gemma4_e2b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | gemma4:e2b |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/conformance_reports/ollama_gemma4_e2b.md |
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
| `errors.missing_messages` | ✅ |  |

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
| `parameters.top_p` | ✅ |  |
| `parameters.max_completion_tokens` | ❌ | asking for at most 8 tokens gave 515 characters against 515 with no budget, and finish_reason was stop, and the older spelling max_tokens failed: the endpoint returned no answer text |
| `parameters.stop` | ❌ | the endpoint returned no answer text |
| `parameters.seed` | ✅ |  |

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
