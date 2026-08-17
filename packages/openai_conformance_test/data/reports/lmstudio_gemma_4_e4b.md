# OpenAI Compatibility Report

## Summary

- Passed: 28
- Failed: 3
- Skipped: 1
- Warned: 0

Compatibility: 90.3%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-17T15:02:29.496Z
- Endpoint: `http://localhost:1234/v1`
- Model: `google/gemma-4-e4b`

### Command Line

```bash
openai_conformance_test --model google/gemma-4-e4b --base_url http://localhost:1234/v1 --profile full --format markdown --output data/reports/lmstudio_gemma_4_e4b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | google/gemma-4-e4b |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/reports/lmstudio_gemma_4_e4b.md |
| `--base_url` | http://localhost:1234/v1 |
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
| `errors.unknown_model` | ❌ | expected an error status, got HTTP 200: {"id":"chatcmpl-0y6dbfrovvc94gvie5mdry1","object":"chat.completion","created":1786978904,"model":"google/gemma-4-e4b","choices":[{"index":0,"message":{"role":"assistant","content":"Hello! How can I help you today?","reasoning_content":"","tool_calls":[]},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20,"completion_tokens_details":{"reasoning_tokens":0}},"stats":{},"system_fingerprint":"google/gemma-4-e4b"} |
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
| `parameters.top_p` | ✅ |  |
| `parameters.max_completion_tokens` | ✅ |  |
| `parameters.stop` | ✅ |  |
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
