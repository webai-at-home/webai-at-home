# OpenAI Compatibility Report

## Summary

- Passed: 25
- Failed: 6
- Skipped: 1
- Warned: 0

Compatibility: 80.6%

A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.

## Test Run

- Generated: 2026-08-17T11:54:06.019Z
- Endpoint: `http://localhost:1234/v1`
- Model: `qwen3.5-2b`

### Command Line

```bash
openai_conformance_test --model qwen3.5-2b --base_url http://localhost:1234/v1 --profile full --format markdown --output data/conformance_reports/lmstudio_qwen3_5_2b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | qwen3.5-2b |
| `--profile` | full |
| `--repeats` | 3 |
| `--output` | data/conformance_reports/lmstudio_qwen3_5_2b.md |
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
| `errors.unknown_model` | ❌ | expected an error status, got HTTP 200: {"id":"chatcmpl-7okttflcu3490kr2zb06d","object":"chat.completion","created":1786966898,"model":"qwen3.5-2b","choices":[{"index":0,"message":{"role":"assistant","content":"Hello! 👋 How can I assist you today? Is there something specific you'd like to chat about or work on?","reasoning_content":"Thinking Process:\n\n1.  **Analyze the Request:**\n    *   Input: \"Hello\"\n    *   Intent: Greeting, initiating conversation.\n    *   Tone: Friendly, polite, open-ended.\n    *   Goal: Respond appropriately to acknowledge the greeting and invite further interaction.\n\n2.  **Determine the appropriate response:**\n    *   Acknowledge the greeting (\"Hello!\").\n    *   Offer assistance or ask how I can help them today.\n    *   Keep it concise but warm.\n\n3.  **Drafting options:**\n    *   Option 1: \"Hi there! How can I help you?\" (Standard)\n    *   Option 2: \"Hello! What's on your mind today?\" (Friendly)\n    *   Option 3: \"Hey! Ready to chat or need something done?\" (Action-oriented)\n\n4.  **Selecting the best option:** A mix of warmth and utility is usually best for an AI assistant. Let's go with a friendly greeting followed by an offer to assist.\n\n5.  **Final Polish:** \"Hello! How can I help you today?\" or \"Hi there! What would you like to talk about or work on?\"\n\n6.  **Refining based on safety guidelines:** No sensitive topics needed here. Just a standard greeting response.\n\n7.  **Final Output Generation:** (Matches the selected draft)\n    \"Hello! How can I help you today? Is there something specific you'd like to chat about or work on?\"\n\n8.  **Wait, keep it simple.** The user just said \"Hello\". A simple, friendly response is best.\n    *   \"Hi there! How are you doing today?\"\n    *   Or: \"Hello! I'm ready to help with whatever you need.\"\n\n    Let's combine them for a natural flow.\n    \"Hello! 👋 How can I assist you today? Feel free to ask me anything or just say what's on your mind!\"\n\n    Actually, keeping it very direct is often better:\n    \"Hi there! How can I help you?\"\n\n    Let's go with a slightly more conversational tone.\n    \"Hello! 👋 It's great to meet you too. How are things going for you today? Is there anything specific you'd like me to help you with?\"\n\n    Wait, the prompt is just \"Hello\". I should respond warmly and offer assistance.\n\n    *Revised Plan:*\n    1. Greet back.\n    2. Offer help.\n    3. Keep it brief.\n\n    *Final Choice:* \"Hi there! 👋 How can I help you today? Is there something specific you'd like to chat about or work on?\"\n\n    Wait, looking at the system instructions... no special constraints here other than being helpful and harmless.\n\n    Let's make it friendly.\n    \"Hello! 👋 How are you doing today? Is there anything I can help you with?\"\n\n    Okay, that works.\n\n    *Self-Correction:* Keep it concise.\n    \"Hi there! How can I assist you today?\"\n\n    Or even simpler:\n    \"Hello! How can I help you?\"\n\n    Let's add a bit of warmth.\n    \"Hello! 👋 It's nice to connect with you. What would you like to talk about or work on first?\"\n\n    Okay, final decision:\n    \"Hi there! 👋 How can I assist you today? Is there something specific you'd like to chat about or need help with?\"\n\n    Wait, actually, just a simple greeting is often enough for a very short input. But since this is an AI assistant, offering help is standard protocol.\n\n    Let's go with: \"Hello! 👋 How can I help you today?\"\n    Or slightly more conversational: \"Hi there! How are things going? Is there anything specific you'd like to chat about or work on?\"\n\n    Okay, let's stick to a friendly, helpful response.\n    \"Hello! 👋 How can I assist you today? Feel free to ask me anything!\"\n\n    Wait, the user might just be testing the bot. So being open is key.\n    \"Hi there! 👋 How are things going for you today? Is there something specific you'd like to chat about or work on?\"\n\n    Okay, that's good. I will use a friendly tone.\n\n    *Final check:* Does this violate any policies? No. Is it helpful? Yes. Is it harmless? Yes.\n\n    Let's write the response.cw\n","tool_calls":[]},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":1001,"total_tokens":1012,"completion_tokens_details":{"reasoning_tokens":964}},"stats":{},"system_fingerprint":"qwen3.5-2b"} |
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
| `parameters.temperature` | ❌ | the endpoint returned no answer text |
| `parameters.top_p` | ❌ | the endpoint returned no answer text |
| `parameters.max_completion_tokens` | ❌ | the endpoint returned no answer text |
| `parameters.stop` | ❌ | the endpoint returned no answer text |
| `parameters.seed` | ✅ |  |

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
