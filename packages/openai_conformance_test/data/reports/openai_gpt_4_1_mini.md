# OpenAI Compatibility Report

## Summary

- Passed: 32
- Failed: 0
- Skipped: 0
- Warned: 0

Compatibility: 100.0%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-17T14:41:40.953Z
- Endpoint: `https://api.openai.com/v1`
- Model: `gpt-4.1-mini`

### Command Line

```bash
openai_conformance_test --model gpt-4.1-mini --base_url https://api.openai.com/v1 --profile full --format markdown --output data/reports/openai_gpt_4_1_mini.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | gpt-4.1-mini |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/reports/openai_gpt_4_1_mini.md |
| `--base_url` | https://api.openai.com/v1 |
| `--api_key` | <redacted> |
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
| `parameters.max_completion_tokens` | ✅ |  |
| `parameters.stop` | ✅ |  |
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
