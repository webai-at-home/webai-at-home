# OpenAI API Benchmark Report

## Summary

- Models measured: 1
- Models not measured: 0
- Quickest to first character: `google/gemma-4-e2b` at 558.86 ms average
- Quickest to last character: `google/gemma-4-e2b` at 2304.29 ms average
- Fastest output: `google/gemma-4-e2b` at 62.45 characters/second average

## Measurement Run

- Generated: 2026-08-19T01:50:57.624Z
- Endpoint: `http://localhost:1234/v1`
- Model: `google/gemma-4-e2b`

### Command Line

```bash
openai_test benchmark --base_url http://localhost:1234/v1 --model google/gemma-4-e2b --format markdown --output data/benchmark_reports/lmstudio_gemma_4_e2b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | google/gemma-4-e2b |
| `--prompt` | Count up to 30 |
| `--runs` | 1 |
| `--warmup_runs` | 1 |
| `--thinking` | off |
| `--output` | data/benchmark_reports/lmstudio_gemma_4_e2b.md |
| `--base_url` | http://localhost:1234/v1 |
| `--api_key` | no-key-required |
| `--timeout_ms` | 600000 |
| `--format` | markdown |

## What Was Measured

Each model was sent the same prompt once, and every request asked for its answer in pieces, so that Time to First Character and Time to Last Character are two separate numbers rather than one. No two requests were ever in flight at once, which is why parallelism is 1 in every report this program writes: a second request in flight changes what the first one measures. One warm-up request was sent first and its answer thrown away, so that the first measured request is not the one that loaded the model.

Every request carried `reasoning_effort: "none"`, so a model that would otherwise think answered straight away. This matters more than any other setting here: thinking happens before the first character of the answer, so all of it lands inside Time to First Character and none of it inside Output Characters. Measured on `gemma4:e2b`, turning it off took Time to First Character from between 2662 ms and 4618 ms down to under 600 ms.

| Metric | What it means |
| --- | --- |
| Time to First Character | How long from sending the request until the first character of the answer arrived. This is how long somebody waits in front of a blank screen. |
| Time to Last Character | How long from sending the request until the last character arrived. This is how long the whole answer took. |
| Output Characters per Second | The answer divided by the time between its first character and its last. This is how fast the text arrived once it had started arriving. |
| Input Characters | How long the prompt was. The same for every request of one run, since one prompt is sent every time. |
| Output Characters | How long the answer was. It changes from request to request, because a model is free to answer the same prompt differently each time. |

None of the five is a token count. A character is what both ends can count without agreeing on a tokenizer first, which is what makes two different endpoints comparable here.

## `google/gemma-4-e2b`

| Metric | Average | Median | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Time to First Character | 558.86 ms | 558.86 ms | 558.86 ms | 558.86 ms |
| Time to Last Character | 2304.29 ms | 2304.29 ms | 2304.29 ms | 2304.29 ms |
| Output Characters per Second | 62.45 chars/s | 62.45 chars/s | 62.45 chars/s | 62.45 chars/s |
| Output Characters | 109.00 chars | 109.00 chars | 109.00 chars | 109.00 chars |

Input Characters: 14, the same for every request below.

### Every Measured Request

| Request | Time to First Character | Time to Last Character | Output Characters per Second | Output Characters |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 558.86 ms | 2304.29 ms | 62.45 chars/s | 109 chars |
