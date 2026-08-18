# Directory Context: `/packages/openai_test/src/conformance/probes`

## Purpose

Runs each prober of `src/probers/` exactly once per run, and translates that prober's five statuses into this package's four verdicts.

## Key Exports & Entry Points

- `tool_call_probe_cache.ts`: `ToolCallProbeCache`, runs `ToolCallProber.probeAll` lazily and once; every test after the first awaits the same promise.
- `generation_control_probe_cache.ts`: `GenerationControlProbeCache`, the same arrangement over `GenerationControlProber.probeAll`.
- `tool_call_verdict.ts`: `ToolCallVerdict`, `supported` → `PASS`, `refused` → `SKIP`, `unsupported` → `WARN`, `inconclusive` → `WARN`, `failed` → `FAIL`.
- `generation_control_verdict.ts`: `GenerationControlVerdict`, the same five statuses, except `not_honoured` → `FAIL`.

## Rules

- `ToolCallProber` and `GenerationControlProber` live in `src/probers/` and are read from here, never reimplemented here; see decision two of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- A cache runs its prober once per run. `probeAll` sends several requests per ability, so a test calling it directly would multiply the whole run's cost by the number of tests in its group. A second tools test therefore sends no further request at all.
- `GenerationControlVerdict` reads `not_honoured` as `FAIL` where `ToolCallVerdict` reads `unsupported` as `WARN`. The two look alike and are not, and neither reading may be copied onto the other.

## Background

- Whether a generation control is applied is the server's own doing, so a server that accepts `temperature` and quietly ignores it has claimed something untrue — section 10 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) words it as "feature claims support but behaves incorrectly". Whether a model asks for a tool is the model's choice afresh on every request, which is why the matching tool call status is only a warning.
