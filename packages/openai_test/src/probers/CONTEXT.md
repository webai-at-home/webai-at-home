# Directory Context: `/packages/openai_test/src/probers`

## Purpose

Finds out what the model behind an endpoint can actually do, rather than what the endpoint says it accepts. Each prober sends several requests and compares the answers, because a control accepted and quietly ignored looks exactly like a control that works until it is measured.

## Key Exports & Entry Points

- `generation_control_prober.ts`: `GenerationControlProber`, which probes `temperature`, `top_p`, `max_completion_tokens`, `stop`, and `seed`, and reports each as `honoured`, `not_honoured`, `refused`, `inconclusive`, or `failed`.
- `tool_call_prober.ts`: `ToolCallProber`, which probes the six separate tool call abilities and reports each as `supported`, `unsupported`, `refused`, `inconclusive`, or `failed`.
- `answer_length_cap.ts`: `AnswerLengthCap`, the output budget probe requests carry, decided once against the endpoint itself.

## Rules

- A prober concludes nothing from the endpoint having accepted a field. Every conclusion comes from comparing what came back across repeated requests.
- A refusal that names the field at fault is an answer about the endpoint, never a fault in the run: `refused` is a status, not an error.
- A prober reports its own five statuses and knows nothing of `PASS`, `FAIL`, `SKIP`, or `WARN`. Translating one into the other belongs to `../conformance/probes/`.
- Every request goes through `../clients/completion_sender.ts`.
- A probe carries the output budget of `AnswerLengthCap` only after one request carrying it has come back with text, and never on a request whose verdict a budget could change: the `max_completion_tokens` probe, the `stop` probe, and the request that asks about one control on its own.

## Background

- The generation control probes come from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), and the six separate tool call probes from [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), whose de-risk gate found a server that read the tool wire format correctly, accepted every tool declaration, and still never generated a single call.
- The output budget is proved before it is used because two endpoints refuse it in two ways: this project's own `consumer_openai` server refuses a control it cannot honour outright, and a thinking model spends the whole budget on reasoning and answers with no text at all, which is what `google/gemma-4-e2b` on LM Studio 0.4.20 did to `parameters.max_completion_tokens` and `parameters.stop`.
- Both probers were shared between the two packages merged by [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208), one importing them from the other. Here they are the only copy this package uses.
