# OpenAI Compatibility Report

## Summary

- Passed: 38
- Failed: 0
- Skipped: 6
- Warned: 0

Compatibility: 100.0%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-21T17:28:05.573Z
- Endpoint: `http://localhost:8788/v1`
- Model: `llm_gemma_4_e2b_full`

### Command Line

```bash
openai_test conformance --model llm_gemma_4_e2b_full --profile full --format markdown --output data/conformance_reports/webai_at_home_llm_gemma_4_e2b_full.conformance_report.md --thinking on -v
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | llm_gemma_4_e2b_full |
| `--profile` | full |
| `--repeats` | 3 |
| `--thinking` | on |
| `--output` | data/conformance_reports/webai_at_home_llm_gemma_4_e2b_full.conformance_report.md |
| `--verbose` | true |
| `--base_url` | http://localhost:8788/v1 |
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
| `tools.generates_a_call_when_forced` (stream off) | ⊘ | This server cannot enforce tool_choice "required", and refuses a request it would have to accept and then ignore. Enforcing it means constraining generation, which the chat templates this cluster drives cannot express. Send tool_choice "auto" to let the model decide, or "none" to declare the tools without letting it ask for one. |
| `tools.generates_a_call_when_forced` (stream on) | ⊘ | This server cannot enforce tool_choice "required", and refuses a request it would have to accept and then ignore. Enforcing it means constraining generation, which the chat templates this cluster drives cannot express. Send tool_choice "auto" to let the model decide, or "none" to declare the tools without letting it ask for one. |
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
| `parameters.top_p` (stream off) | ⊘ | The model llm_gemma_4_e2b_full cannot honour top_p, and this server refuses a request it would have to ignore rather than answering it as though nothing had been asked for. The generation controls llm_gemma_4_e2b_full honours are temperature, max_completion_tokens, stop. Send the request again without top_p, or send it to a model that honours it. |
| `parameters.top_p` (stream on) | ⊘ | The model llm_gemma_4_e2b_full cannot honour top_p, and this server refuses a request it would have to ignore rather than answering it as though nothing had been asked for. The generation controls llm_gemma_4_e2b_full honours are temperature, max_completion_tokens, stop. Send the request again without top_p, or send it to a model that honours it. |
| `parameters.max_completion_tokens` (stream off) | ✅ |  |
| `parameters.max_completion_tokens` (stream on) | ✅ |  |
| `parameters.stop` (stream off) | ✅ |  |
| `parameters.stop` (stream on) | ✅ |  |
| `parameters.seed` (stream off) | ⊘ | The model llm_gemma_4_e2b_full cannot honour seed, and this server refuses a request it would have to ignore rather than answering it as though nothing had been asked for. The generation controls llm_gemma_4_e2b_full honours are temperature, max_completion_tokens, stop. Send the request again without seed, or send it to a model that honours it. |
| `parameters.seed` (stream on) | ⊘ | The model llm_gemma_4_e2b_full cannot honour seed, and this server refuses a request it would have to ignore rather than answering it as though nothing had been asked for. The generation controls llm_gemma_4_e2b_full honours are temperature, max_completion_tokens, stop. Send the request again without seed, or send it to a model that honours it. |
