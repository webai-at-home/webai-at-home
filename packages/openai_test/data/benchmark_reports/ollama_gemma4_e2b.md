# OpenAI API Benchmark Report

## Summary

- Models measured: 1
- Models not measured: 0
- Quickest to first character: `gemma4:e2b` at 3814.83 ms average
- Quickest to last character: `gemma4:e2b` at 5824.22 ms average
- Fastest output: `gemma4:e2b` at 54.25 characters/second average

## Measurement Run

- Generated: 2026-08-19T01:31:23.468Z
- Endpoint: `http://localhost:11434/v1`
- Model: `gemma4:e2b`

### Command Line

```bash
openai_test benchmark --base_url http://localhost:11434/v1 --model gemma4:e2b --format markdown --output data/benchmark_reports/ollama_gemma4_e2b.md
```

### Parameters

| Option | Value |
| --- | --- |
| `--model` | gemma4:e2b |
| `--prompt` | Count up to 30 |
| `--runs` | 3 |
| `--warmup_runs` | 1 |
| `--output` | data/benchmark_reports/ollama_gemma4_e2b.md |
| `--base_url` | http://localhost:11434/v1 |
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

## `gemma4:e2b`

| Metric | Average | Median | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Time to First Character | 3814.83 ms | 4490.07 ms | 1864.48 ms | 5089.96 ms |
| Time to Last Character | 5824.22 ms | 6488.48 ms | 3863.22 ms | 7120.96 ms |
| Output Characters per Second | 54.25 chars/s | 54.16 chars/s | 53.54 chars/s | 55.03 chars/s |
| Output Characters | 109.00 chars | 110.00 chars | 107.00 chars | 110.00 chars |

Input Characters: 14, the same for every request below.

### Every Measured Request

| Request | Time to First Character | Time to Last Character | Output Characters per Second | Output Characters |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5089.96 ms | 7120.96 ms | 54.16 chars/s | 110 chars |
| 2 | 4490.07 ms | 6488.48 ms | 53.54 chars/s | 107 chars |
| 3 | 1864.48 ms | 3863.22 ms | 55.03 chars/s | 110 chars |
