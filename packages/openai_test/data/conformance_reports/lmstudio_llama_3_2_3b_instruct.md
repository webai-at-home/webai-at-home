# OpenAI API Conformance Test

- Endpoint: http://localhost:1234/v1
- Models measured: 1
- Tests: 33
- Generated: 2026-08-18T17:40:46.597Z

## Command line

```
openai_test conformance --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --profile full --format markdown --output data/conformance_reports/lmstudio_llama_3_2_3b_instruct.md
```

## Verdict matrix

Legend: ✅ PASS, ❌ FAIL, ⚠️ WARN, ⏭️ SKIP.

A cell holding two verdicts is a test the request mode reaches, written `nostream / streamed`. Every other test is measured once, because the mode reaches the generation control and tool call probes and nothing else.

| Test | llama-3.2-3b-instruct |
| --- | --- |
| `models.list` | ✅ |
| `chat.basic` | ✅ |
| `chat.system_message` | ✅ |
| `usage.present` | ✅ |
| `usage.total_is_sum` | ✅ |
| `errors.unknown_model` | ❌ |
| `errors.malformed_json` | ✅ |
| `errors.missing_messages` | ❌ |
| `history.accepted` | ✅ |
| `history.recalled` | ✅ |
| `streaming.headers` | ✅ |
| `streaming.basic` | ✅ |
| `streaming.content_concatenates` | ✅ |
| `streaming.finish_reason` | ✅ |
| `streaming.done` | ✅ |
| `streaming.timing` | ✅ |
| `structured_output.json_object` | ⏭️ |
| `structured_output.json_schema` | ✅ |
| `sdk.node.models_list` | ✅ |
| `sdk.node.basic` | ✅ |
| `sdk.node.streaming` | ✅ |
| `sdk.node.tools` | ✅ |
| `tools.generates_a_call` | ⚠️ / ⚠️ |
| `tools.generates_a_call_when_forced` | ⚠️ / ⚠️ |
| `tools.fills_in_the_arguments` | ⚠️ / ⚠️ |
| `tools.chooses_among_several_tools` | ⚠️ / ⚠️ |
| `tools.reads_a_tool_result_back` | ✅ / ✅ |
| `tools.answers_without_a_call_when_none_is_needed` | ✅ / ✅ |
| `parameters.temperature` | ✅ / ✅ |
| `parameters.top_p` | ✅ / ✅ |
| `parameters.max_completion_tokens` | ✅ / ✅ |
| `parameters.stop` | ✅ / ✅ |
| `parameters.seed` | ✅ / ✅ |

## Summary

| Model | Mode | Passed | Failed | Warned | Skipped | Compatibility |
| --- | --- | --- | --- | --- | --- | --- |
| llama-3.2-3b-instruct | not mode-dependent | 19 | 2 | 0 | 1 | 90.5% |
| llama-3.2-3b-instruct | nostream | 7 | 0 | 4 | 0 | 63.6% |
| llama-3.2-3b-instruct | streamed | 7 | 0 | 4 | 0 | 63.6% |

