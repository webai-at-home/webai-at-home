# A mixture of experts generating with its weights on disk

Milestone 6 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169), and the deliverable of [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168): a model larger than the machine's graphics memory, and larger than its main memory, generating text in a browser, with the weights that are not being used kept on disk.

**Qwen3-30B-A3B is 30.5 billion parameters.** Converted, its 6144 experts come to 15.61 gigabytes and its always-resident part to a further 5.16. The machine this was measured on has 16 gigabytes of memory in total. It generates anyway, because at any moment only 8 experts of each of the 48 layers are needed, which is 384 of the 6144.

## What the page does

It runs the same model, through the same graphs, with the same arithmetic, once for each of the three places the expert weights can live. Everything about the three runs is identical except what has to happen before an expert can be multiplied by anything:

- **in graphics memory** — every expert is read in before the first token, and no expert is ever read again.
- **in main memory** — every expert is held in processor-side arrays, and each miss copies one block into the staging buffer.
- **on disk** — every expert stays in the Origin Private File System, and each miss reads one block through a synchronous access handle.

A warm-up of two tokens is generated and thrown away first, so that no run is timed while it is compiling shaders.

**A line that stops is the point of the picture.** A storage class that cannot hold the model has no point at that size, and the page reports that as the finding rather than as a failure of the run. The whole claim of issue #168 is that the disk line keeps going after the other two have run out.

## The measurements

Measured in Chrome on a machine with 16 gigabytes of memory. The cache holds one and a half times a single token's working set — 576 experts for Qwen3-30B-A3B, 192 for OLMoE-1B-7B-0924 — because milestone 5 measured that a cache below one token's working set hits exactly zero times, which measures the store's bandwidth rather than the design.

Sixteen tokens for each run, from the prompt `The capital of France is`, generated greedily.

| model | experts | in graphics memory | in main memory | on disk |
| --- | --- | --- | --- | --- |
| OLMoE-1B-7B-0924 | 3.47 GB | 0.667 tokens each second | 0.613 | **1.888** |
| Qwen3-30B-A3B | 15.61 GB | 0.104 | **could not hold it** | **0.134** |

Three things in that table are worth reading twice.

**The main memory line stops.** Qwen3-30B-A3B's experts were read into processor-side arrays half a gigabyte at a time, and the machine took 13.94 gigabytes of the 15.61 and refused the next half. That is the deliverable of issue #168 in one row: the storage class that most people would reach for cannot hold this model, and the disk one can.

**Disk beats both of the others, at both sizes.** That looks wrong and is not. The cache holds a working set either way, so the disk run is not reading 15.61 gigabytes for each token — it read 11.86 gigabytes over 16 tokens and hit in graphics memory 39.2 per cent of the time. What the other two runs pay is the whole model sitting in memory at once on a machine that has 16 gigabytes in total, which pushes everything else — the graphs, the cache, the browser — into the swap file. Holding all the weights costs more here than fetching the few that are wanted.

**Every storage class produced the same words.** For each model the three runs generated identical text, which is what the residency layer has to be true for:

```
OLMoE-1B-7B-0924:  The capital of France is Paris.

                   The capital of the United States is Washington, D.C
Qwen3-30B-A3B:     The capital of France is Paris. Which of the following is the capital of the United Kingdom? A.
```

Against the processor, agreement is close rather than exact. `gate_moe_whole_model.py` generated `Paris. Which of the following is the capital of Germany?` from the same files: the first seven tokens are identical and then the two split at a point where several continuations are near-equally likely. The browser runs the experts on WebGPU and the gate runs them on the processor, the two execution providers agree to about 4e-5 on one layer, and greedy decoding turns a difference that small into a different word as soon as two candidates are close. Identical tokens are claimed **between the three storage classes**, which run the same arithmetic on the same device, and not between the browser and the processor, which do not.

## Where the bytes come from

The expert blocks are copied once into the Origin Private File System and kept. That copy is what milestone 4 measured and it is not repeated here: the store fills from block zero upwards and its length is the record of how far it got, so closing the page loses at most the request in flight.

The graphs and the block file are generated artifacts, far too large to sit under `public/`, so the development server serves them from wherever they were written, with the byte range support Hugging Face gives. See [the tools README](../../tools/README.md) for the commands that write them.

## The one that nearly did not work

The first time this page ran Qwen3-30B-A3B it produced this:

```
,…

ing一,

Mid=wickFdi
```

Every gate was green. The layer graph matched the reference implementation to 7.875e-06, the whole model assembled outside the browser and produced `The capital of France is Paris. Which of the following is the capital of Germany?`, and the expert block graph was bracketed between single and half precision. All of them ran on the **processor**.

Grouped-query attention gives each of Qwen3-30B-A3B's 4 key heads to 8 query heads, and the graph did that with one `Concat` of eight copies. Eight inputs and one output is nine storage buffers, and Chrome creates its WebGPU device with a limit of eight. The pipeline does not compile, so the submission it belongs to is dropped, so the values read back as zeros — and nothing is thrown. The session is created, `run` resolves, tensors of the right shape come back, and the model generates fluent-looking nonsense.

[The WebGPU layer graph gate](../qwen3-layer-graph-webgpu-gate/README.md) is what found it and is what stops it coming back.

## Running it

The in-app browser cannot run this. It grants about 3.38 gigabytes of Origin Private File System quota and refuses persistence, and Qwen3-30B-A3B needs 15.61. Use Chrome.

```sh
npm --workspace @webai/onnx_experiments run dev
```

Then open `/moe-experts-on-disk/`, choose a model, and run it. Everything measured is kept, so running the other model as well fills the curve in.
