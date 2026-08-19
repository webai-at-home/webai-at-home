# OpenAI API Conformance Test

- Endpoint: http://localhost:11434/v1
- Models measured: 1
- Tests: 33
- Generated: 2026-08-19T00:23:54.771Z

## Command line

```
openai_test conformance --base_url http://localhost:11434/v1 --model gemma4:e2b --profile full --format markdown --output data/conformance_reports/ollama_gemma4_e2b.md -v
```

## Verdict matrix

Legend: ✅ PASS, ❌ FAIL, ⚠️ WARN, ⏭️ SKIP.

A cell holding two verdicts is a test the request mode reaches, written `nostream / streamed`. Every other test is measured once, because the mode reaches the generation control and tool call probes and nothing else.

| Test | gemma4:e2b |
| --- | --- |
| `models.list` | ✅ |
| `chat.basic` | ✅ |
| `chat.system_message` | ✅ |
| `usage.present` | ✅ |
| `usage.total_is_sum` | ✅ |
| `errors.unknown_model` | ✅ |
| `errors.malformed_json` | ✅ |
| `errors.missing_messages` | ✅ |
| `history.accepted` | ✅ |
| `history.recalled` | ✅ |
| `streaming.headers` | ✅ |
| `streaming.basic` | ✅ |
| `streaming.content_concatenates` | ✅ |
| `streaming.finish_reason` | ✅ |
| `streaming.done` | ✅ |
| `streaming.timing` | ✅ |
| `structured_output.json_object` | ✅ |
| `structured_output.json_schema` | ✅ |
| `sdk.node.models_list` | ✅ |
| `sdk.node.basic` | ✅ |
| `sdk.node.streaming` | ✅ |
| `sdk.node.tools` | ✅ |
| `tools.generates_a_call` | ✅ / ✅ |
| `tools.generates_a_call_when_forced` | ✅ / ✅ |
| `tools.fills_in_the_arguments` | ✅ / ✅ |
| `tools.chooses_among_several_tools` | ✅ / ✅ |
| `tools.reads_a_tool_result_back` | ✅ / ✅ |
| `tools.answers_without_a_call_when_none_is_needed` | ✅ / ✅ |
| `parameters.temperature` | ✅ / ✅ |
| `parameters.top_p` | ✅ / ✅ |
| `parameters.max_completion_tokens` | ❌ / ❌ |
| `parameters.stop` | ❌ / ❌ |
| `parameters.seed` | ✅ / ✅ |

## Summary

| Model | Mode | Passed | Failed | Warned | Skipped | Compatibility |
| --- | --- | --- | --- | --- | --- | --- |
| gemma4:e2b | not mode-dependent | 22 | 0 | 0 | 0 | 100.0% |
| gemma4:e2b | nostream | 9 | 2 | 0 | 0 | 81.8% |
| gemma4:e2b | streamed | 9 | 2 | 0 | 0 | 81.8% |

