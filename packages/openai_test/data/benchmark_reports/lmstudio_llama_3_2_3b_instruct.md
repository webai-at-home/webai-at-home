# OpenAI API Benchmark Report

## Summary

- Models measured: 1
- Models not measured: 0
- Quickest to first character: `llama-3.2-3b-instruct` at 35.85 ms average
- Quickest to last character: `llama-3.2-3b-instruct` at 2175.09 ms average
- Fastest output: `llama-3.2-3b-instruct` at 58.16 characters/second average

## Measurement Run

- Generated: 2026-08-19T01:32:39.596Z
- Endpoint: `http://localhost:1234/v1`
- Model: `llama-3.2-3b-instruct`

### Command Line

```bash
openai_test benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --format markdown --output data/benchmark_reports/lmstudio_llama_3_2_3b_instruct.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | llama-3.2-3b-instruct |
| `--prompt` | Count up to 30 |
| `--runs` | 3 |
| `--warmup_runs` | 1 |
| `--output` | data/benchmark_reports/lmstudio_llama_3_2_3b_instruct.md |
| `--base_url` | http://localhost:1234/v1 |
| `--api_key` | no-key-required |
| `--timeout_ms` | 600000 |
| `--format` | markdown |

## What Was Measured

Each model was sent the same prompt 3 times, and every request asked for its answer in pieces, so that Time to First Character and Time to Last Character are two separate numbers rather than one. No two requests were ever in flight at once, which is why parallelism is 1 in every report this program writes: a second request in flight changes what the first one measures. One warm-up request was sent first and its answer thrown away, so that the first measured request is not the one that loaded the model.

| Metric | What it means |
| --- | --- |
| Time to First Character | How long from sending the request until the first character of the answer arrived. This is how long somebody waits in front of a blank screen. |
| Time to Last Character | How long from sending the request until the last character arrived. This is how long the whole answer took. |
| Output Characters per Second | The answer divided by the time between its first character and its last. This is how fast the text arrived once it had started arriving. |
| Input Characters | How long the prompt was. The same for every request of one run, since one prompt is sent every time. |
| Output Characters | How long the answer was. It changes from request to request, because a model is free to answer the same prompt differently each time. |

None of the five is a token count. A character is what both ends can count without agreeing on a tokenizer first, which is what makes two different endpoints comparable here.

## `llama-3.2-3b-instruct`

| Metric | Average | Median | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Time to First Character | 35.85 ms | 35.91 ms | 33.85 ms | 37.79 ms |
| Time to Last Character | 2175.09 ms | 2152.70 ms | 2116.42 ms | 2256.16 ms |
| Output Characters per Second | 58.16 chars/s | 58.05 chars/s | 56.35 chars/s | 60.08 chars/s |
| Output Characters | 124.33 chars | 125.00 chars | 123.00 chars | 125.00 chars |

Input Characters: 14, the same for every request below.

### Every Measured Request

| Request | Time to First Character | Time to Last Character | Output Characters per Second | Output Characters |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 35.91 ms | 2116.42 ms | 60.08 chars/s | 125 chars |
| 2 | 37.79 ms | 2256.16 ms | 56.35 chars/s | 125 chars |
| 3 | 33.85 ms | 2152.70 ms | 58.05 chars/s | 123 chars |
