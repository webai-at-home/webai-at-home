# OLMoE-1B-7B-0924 run twice, once resident and once streamed · Issue #169 milestone 5

This is what [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168) asks for, at a size that still fits on the machine: a whole mixture-of-experts model generating in a browser with its experts kept on disk and read into graphics memory as each token chooses them.

Milestone 4 built the residency layer and measured what moving experts costs, driven by a **synthetic** sequence of expert selections, because there was no model to ask. This page replaces the synthetic sequence with a real router reading a real prompt, and asks the one question that decides whether any of it is usable:

> Does a model whose experts are streamed from disk produce **exactly** the same tokens as the same model with every expert already in graphics memory?

Being close is worth nothing. One token whose two best candidates sit a hair apart turns any difference at all into a different word, and then into a different sentence. So this page does not measure accuracy. It compares sequences of token identifiers and requires them to be equal.

## Result

**MILESTONE 5 GREEN.** Measured on 13 August 2026, in Chrome on Apple Silicon with 16 gigabytes of unified memory, on the `metal-3` adapter, with `onnxruntime-web` 1.27. Prompt `The capital of France is`, 24 tokens, greedy.

| run | slots | hit rate | read while generating | tokens each second |
| --- | --- | --- | --- | --- |
| every expert resident | 1024 | 100.0 % | 0 MB | 0.71 |
| streamed | 192 | 34.8 % | 8103 MB | 0.58 |
| streamed | 64 | **0.0 %** | 12432 MB | 0.47 |

All three produced **the same 29 token identifiers, in the same order**:

> The capital of France is Paris.
>
> The capital of the United States is Washington, D.C.
>
> The capital of the United

The third row is the real test. A cache of 64 holds less than one token wants, so **every one of the 3584 expert lookups was a read from disk** — 12.4 gigabytes moved through the staging ring, every expert evicted and read back, and not one token moved.

## Why a cache of 64 hits exactly zero times

Each of the 16 layers chooses 8 experts and no two layers share one, so **one token wants 128 distinct experts**. A cache of 64 has thrown out everything from the previous token before the next token asks for it. The hit rate is zero by arithmetic, not by any fault of the least-recently-used policy.

That is why there are two streamed runs. A cache of 192 is one and a half times the working set, so experts survive from one token to the next and the policy has something to be right about — 34.8 per cent. Together they show the cache working and show it being defeated, and both produce identical tokens.

## What is streamed and what is not

Only the **expert** weights. Everything else is resident for the life of the model and never changes, so it is an ordinary initializer inside a graph:

| | |
| --- | --- |
| 16 layer graphs | normalization, the four attention projections, the query and key normalizations, rotary, attention with a key and value cache, and the router — 64.54 megabytes each |
| the head graph | the final normalization and the language model head — 393.01 megabytes |
| the token embedding | 393.00 megabytes, looked up rather than multiplied, so it is not a graph |
| **the expert graph** | **1379 bytes, because all nine of its weight tensors are runtime inputs** |
| **the expert blocks** | **3.47 gigabytes on disk, 1024 blocks of 3,637,248 bytes, one read at a time** |

The awkward part of this design applies to the experts alone. That is worth knowing before anyone carries it to Qwen3-30B-A3B.

## The control this was read against

`tools/model_graphs/gate_moe_whole_model.py` runs **the same graphs and the same block file** outside the browser, on the processor, with no residency layer at all — every expert read the moment it is wanted. It produces `The capital of France is Paris.` from the same files. So a browser that produced different words would have a browser problem rather than an assembly problem.

It is not a bit-for-bit reference. That one runs on the processor and this one on the graphics processor, and two floating point implementations of the same arithmetic do not agree to the last bit.

## Read the timings as noise, not as a measurement

Milestone 6 is the measurement. These numbers were taken on a machine also holding 3.47 gigabytes of expert blocks in graphics memory, 1.39 gigabytes of graph, and a 15.61-gigabyte store from milestone 4, and they moved by more than a factor of two between two runs of the identical code — an earlier run of the same page reported 1.68 tokens each second where the run above reports 0.71.

What the ordering does say is that streaming costs something real: 0.71 falls to 0.47 when every expert has to be read. What it does not say is what either number would be on a machine that was not swapping.

The runs are preceded by a warm-up that is thrown away, because the first run of a graph compiles its shaders and there are eighteen graphs.

## One thing this found that milestone 4 had wrong

`FileSystemSyncAccessHandle.write()` returns how many bytes it took, and both this page and milestone 4's originally discarded it. On a browser whose quota was 3.15 gigabytes, the fill reported complete success and silently stopped writing at exactly 2000 mebibytes. The model then read whatever happened to sit at the offset it wanted, and failed later with a message about a short read.

Both pages now check the count and say what the browser's quota is when it comes up short. **Milestone 4's conclusion that the quota is not a ceiling needs qualifying**: it is not a *fixed* ceiling, and it does rise as the store fills, but it is a real limit and a browser will enforce it without throwing.

## Run

Everything is generated and nothing is committed. Convert the model, which takes about ten minutes:

```sh
npx tsx packages/_onnx_experiments/tools/weight_conversion/convert_mixture_of_experts_to_expert_blocks.ts --model OLMoE-1B-7B-0924 --output /tmp/olmoe-1b-7b-0924-expert-blocks
```

Build the graphs from the resident half of that conversion:

```sh
packages/_onnx_experiments/tools/.venv/bin/python packages/_onnx_experiments/tools/model_graphs/build_moe_graphs.py --model OLMoE-1B-7B-0924 --blocks /tmp/olmoe-1b-7b-0924-expert-blocks --output /tmp/olmoe-1b-7b-0924-graphs
```

Check the assembly outside the browser first, where a wiring mistake is cheap to find:

```sh
packages/_onnx_experiments/tools/.venv/bin/python packages/_onnx_experiments/tools/model_graphs/gate_moe_whole_model.py --graphs /tmp/olmoe-1b-7b-0924-graphs --blocks /tmp/olmoe-1b-7b-0924-expert-blocks
```

Then start the dev server, which serves both directories with byte range support:

```sh
npm run dev --workspace @webai/onnx-experiments
```

Open `olmoe-run-twice/`. The first visit copies 3.47 gigabytes into the Origin Private File System and keeps it, so later visits skip that. Set `OLMOE_GRAPHS_DIRECTORY` and `OLMOE_BLOCKS_DIRECTORY` if the artifacts were written somewhere other than the two paths above.

**The browser needs about 4 gigabytes of storage quota.** A browser that grants less will stop part way and say so.

See [`../../README.md`](../../README.md) for the other experiments in this package.
