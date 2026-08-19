# OpenAI Compatibility Report

## Summary

- Passed: 33
- Failed: 10
- Skipped: 1
- Warned: 0

Compatibility: 76.7%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-19T02:35:47.038Z
- Endpoint: `http://localhost:1234/v1`
- Model: `google/gemma-4-e2b`

### Command Line

```bash
openai_test conformance --base_url http://localhost:1234/v1 --model google/gemma-4-e2b --profile full --format markdown --output data/conformance_reports/lmstudio_gemma_4_e2b.md -v
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | google/gemma-4-e2b |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/conformance_reports/lmstudio_gemma_4_e2b.md |
| `--verbose` | true |
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

## Usage

| Test | Result | Detail |
| --- | --- | --- |
| `usage.present` | ✅ |  |
| `usage.total_is_sum` | ✅ |  |

## Errors

| Test | Result | Detail |
| --- | --- | --- |
| `errors.unknown_model` | ❌ | expected an error status, got HTTP 200: {"id":"chatcmpl-frb9anv7i6iaptevbd22v7","object":"chat.completion","created":1787106724,"model":"google/gemma-4-e2b","choices":[{"index":0,"message":{"role":"assistant","content":"Hello! How can I help you today?","reasoning_content":"\nThinking Process:\n\n1.  **Analyze the input:** The user simply said \"Hello\". This is a standard, polite greeting.\n2.  **Determine the user's intent:** The user is initiating a conversation or acknowledging my presence. They are being friendly/neutral.\n3.  **Formulate the appropriate response:**\n    *   Acknowledge the greeting (reciprocate the politeness).\n    *   Offer a friendly opening (ask how they are, or ask what they need).\n    *   Keep the tone welcoming and open.\n4.  **Draft potential responses (Internal Monologue/Selection):**\n    *   *Option 1 (Simple):* Hello! How can I help you? (Effective, functional)\n    *   *Option 2 (Friendly/Verbose):* Hi there! It's great to hear from you. What's on your mind today? (Warm, engaging)\n    *   *Option 3 (Direct):* Hello. What do you want to talk about? (Too demanding)\n5.  **Select the best response:** A balance of politeness and prompting is ideal. (Choosing a standard, welcoming yet open-ended response).\n\n6.  **Final Output Generation.** (The resulting output is a welcoming reply.)","tool_calls":[]},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":17,"completion_tokens":287,"total_tokens":304,"completion_tokens_details":{"reasoning_tokens":274}},"stats":{},"system_fingerprint":"google/gemma-4-e2b"} |
| `errors.malformed_json` | ✅ |  |
| `errors.missing_messages` | ❌ | HTTP 400 but no "error" object: {"error":"'messages' field is required"} |

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
| `structured_output.json_object` | ⊘ | json_object is not supported: HTTP 400, {"error":"'response_format.type' must be 'json_schema' or 'text'"} |
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
| `parameters.top_p` (stream off) | ❌ | the answers still varied at temperature 1.6 with top_p 0.01, so the value changed nothing |
| `parameters.top_p` (stream on) | ❌ | the answers still varied at temperature 1.6 with top_p 0.01, so the value changed nothing |
| `parameters.max_completion_tokens` (stream off) | ❌ | the endpoint returned no answer text |
| `parameters.max_completion_tokens` (stream on) | ❌ | the endpoint returned no answer text |
| `parameters.stop` (stream off) | ❌ | the endpoint returned no answer text |
| `parameters.stop` (stream on) | ❌ | the endpoint returned no answer text |
| `parameters.seed` (stream off) | ❌ | seed 42 gave two different answers, so the seed decided nothing |
| `parameters.seed` (stream on) | ❌ | seed 42 gave two different answers, so the seed decided nothing |
