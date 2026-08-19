# `@webai/worker-webpage`

Build and serve the worker browser independently from the central gateway:

```sh
npm run build --workspace @webai/worker-webpage
npm run start --workspace @webai/worker-webpage
```

During development, use `npm run dev --workspace @webai/worker-webpage`. Vite
serves the page on port `8789` by default. The page connects to the central
gateway at `http://localhost:8787` and authenticates with
`development-token` by default. Use `?gatewayUrl=http://host:port` and
`?authToken=token` to connect to a different gateway.

Use `?workerName=name` to choose the registered worker name. Use repeated
`?enabledStages=stage_name` parameters to restrict the stages offered by a
worker. When no stage parameters are provided, the page advertises all
available built-in stages.

Worker pages can receive multiple enabled stages through repeated URL parameters. For example:

```text
?gatewayUrl=http://localhost:8787&workerName=formula-worker&enabledStages=stage_dev_formula_multiply&enabledStages=stage_dev_formula_add
```

When no enabled stages are provided, the worker advertises all available formula and language-model stages.

## About panel

**About** in the navigation bar opens a panel naming which build of the worker webpage this browser tab is running: the version number of `@webai/worker-webpage`, read from its own `package.json` at build time, and the git commit the build was made from. The panel also links to the `/health` route of the central gateway this page is connected to — the gateway named by `?gatewayUrl=` — whose JSON body carries the gateway's own git commit.

It is a panel that opens over the worker webpage rather than a page of its own, so a volunteer whose browser tab is running a stage never leaves that tab. See [issue #159](https://github.com/webai-at-home/webai-at-home/issues/159).

## Qwen3 model shards

The three Qwen3-0.6B ONNX model shards are stored in the public [Hugging Face model repository](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards), rather than in the Worker web build or the central gateway. The Worker downloads only the shard assigned to its stage and stores downloaded shard bytes in the browser's IndexedDB cache.

The Worker uses the immutable Hugging Face revision [`8ba2b869c4dbb96de8b72e448e79b4ec5825ae47`](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards/tree/8ba2b869c4dbb96de8b72e448e79b4ec5825ae47). Upload a new model revision and update the revision in `web/src/stages/stage_helper_llm_qwen3_0_6b_sharded.ts` when the shard files change. The deployed Worker therefore publishes the small application and runtime assets, not the roughly 860 megabytes of model shards.

## Qwen3.5-0.8B complete model

`stage_llm_qwen3_5_0_8b_full` downloads the complete model rather than one part of it, so it needs no shard repository of its own. It downloads directly from [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX), the ONNX export of [`Qwen/Qwen3.5-0.8B`](https://huggingface.co/Qwen/Qwen3.5-0.8B) — the model repository named by [issue #96](https://github.com/webai-at-home/webai-at-home/issues/96) ships no ONNX file, so this export is what is actually downloaded and run.

The Worker is pinned to the immutable revision [`c0d619322dad7c4441a8841a53fc59772ddddcc0`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX/tree/c0d619322dad7c4441a8841a53fc59772ddddcc0), at the `q4f16` quantization, in `web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts`. That quantization measured about 584 megabytes of model weights (a 437 megabyte decoder graph and a 147 megabyte token-embedding graph, each with its weights in a separate external data file) plus a 19 megabyte tokenizer, against the pinned revision.

Unlike the Qwen3-0.6B shards, this model's feeds are built by [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) rather than by hand, because Qwen3.5-0.8B is a hybrid linear-attention and full-attention architecture this project has no reference implementation for. `@huggingface/transformers` downloads and caches the model files itself, in the browser's Cache Storage under its own default cache key (`transformers-cache`), separate from the IndexedDB database the Qwen3-0.6B shards use.

Running the model needs a WebGPU adapter with 16-bit floating point shader support, which the worker page checks before advertising the stage. A live run against the pinned revision, recorded in [issue #96](https://github.com/webai-at-home/webai-at-home/issues/96), measured about 163 seconds to download and load the model on a cold cache, and about 7 seconds to generate a short answer once loaded.

## Llama 3.2 1B Instruct complete model

`stage_llm_llama3_2_1b_full` downloads the complete model rather than one part of it, the same as `stage_llm_qwen3_5_0_8b_full` above. It downloads directly from [`onnx-community/Llama-3.2-1B-Instruct-ONNX`](https://huggingface.co/onnx-community/Llama-3.2-1B-Instruct-ONNX), the ONNX export of the gated repository `meta-llama/Llama-3.2-1B-Instruct` — a browser tab carries no Hugging Face access token to satisfy that gate, and this export was confirmed ungated live before this stage was written (see the de-risk gate below). The model carries the Llama 3.2 Community License, not the Apache 2.0 licence the other models this project downloads carry.

The Worker is pinned to the immutable revision [`14007543b6dc92de88daf96a9aa85d2f95ace6ef`](https://huggingface.co/onnx-community/Llama-3.2-1B-Instruct-ONNX/tree/14007543b6dc92de88daf96a9aa85d2f95ace6ef), at the `q4f16` quantization — the smallest this export publishes — in `web/src/stages/stage_helper_llm_llama3_2_1b_full.ts`. That quantization measured about 1050.4 megabytes total (a 1039.1 megabyte decoder graph and an 11.0 megabyte tokenizer, the rest under a megabyte) against the pinned revision — above the roughly 604 megabyte `stage_helper_llm_qwen3_5_0_8b_full.ts` download, and for a time the largest this project had asked a volunteer device for. The complete Gemma 4 E2B model below is about three times larger again, so the ceiling this paragraph once recorded is no longer the ceiling.

Unlike Qwen3.5-0.8B, this model's feeds are built by [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) for a different reason: Llama 3.2 1B Instruct is an ordinary `LlamaForCausalLM` architecture with a plain `past_key_values` cache on every one of its 16 layers, held complete on one device, not a hybrid linear-attention architecture this project lacks a reference implementation for. It is built on `@huggingface/transformers` anyway, because that library already downloads, caches, and runs this architecture correctly — confirmed with a live run against the pinned revision on the WebGPU backend before this stage was written (see the `packages/_onnx_experiments/public/llama3_2-1b-gate/` de-risk gate for [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154)) — so writing a second implementation by hand would add risk and code for no benefit.

Running the model needs a WebGPU adapter with 16-bit floating point shader support, the same requirement `stage_llm_qwen3_5_0_8b_full` states. Milestone 0's de-risk gate ran in a sandboxed browser environment whose WebGPU backend measured about 390 seconds to download and load the model and well under one token per second to generate; neither figure is representative of real worker hardware, so a true measurement on real hardware is still owed.

This task type can also be run by a native worker instead of a worker browser tab: [`@webai/worker-openai`](../worker_openai/README.md) forwards the prompt to a local OpenAI-compatible server that already holds the model, rather than downloading it into the browser. Either worker type can offer `stage_llm_llama3_2_1b_full`; which one a given task is assigned is not something either worker chooses.

## Gemma 4 E2B instruction-tuned complete model

`stage_llm_gemma_4_e2b_full` downloads the complete model rather than one part of it, the same as the two stages above. It downloads directly from [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX), the ONNX export of [`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it). The repository is ungated, which is what makes the stage possible at all — a browser tab carries no Hugging Face access token. The model carries the Apache 2.0 licence, not the Llama 3.2 Community License that `onnx-community/Llama-3.2-1B-Instruct-ONNX` carries.

The Worker is pinned to the immutable revision [`9f4bef82ea6e296bc69f8a2f5939f73af81b07a6`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/tree/9f4bef82ea6e296bc69f8a2f5939f73af81b07a6), at the `q4f16` quantization — the smallest of the five this export publishes — in `web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts`. That quantization measures about 3111 megabytes across the two graphs a text-only run needs: about 1520 megabytes of merged decoder and about 1591 megabytes of token embeddings, plus a 19 megabyte tokenizer.

The token-embedding graph being larger than the decoder graph is not a mistake in the export. The text part has per-layer input embeddings over a 262144-token vocabulary, so "E2B" describes how many parameters run per token, not how many are stored. A reader who expects a two-billion-parameter model to download like one is wrong by more than a factor of two.

`MINIMUM_FREE_STORAGE_BYTES` in that stage helper is set to 3500 megabytes, so the stage is not offered at all by a tab that cannot hold the download. An embedded browser view is not enough: milestone 4 of [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211) measured one capping an origin at about 2900 megabytes and refusing `navigator.storage.persist()`, while the same machine's real Google Chrome reported 10240 megabytes.

**This stage has no WebAssembly fallback anywhere on its path.** It requires a WebGPU adapter carrying the `shader-f16` feature, and refuses outright without one rather than falling back. That is a deliberate departure from the two stages above: WebAssembly is far too slow to carry a model of this size, and an answer generated that way would prove nothing about the path a real worker takes.

A live run against the pinned revision, in Google Chrome on an `apple metal-3` adapter on 19 August 2026, measured about **466 seconds** to download and load the model on a cold cache, and 11.45, 17.17, and 17.71 tokens per second over three runs of one prompt once loaded — the first slower for warm-up, each producing exactly the same 44 tokens, which is what greedy decoding should do. The tab's main thread is unresponsive for most of that load.

Which of the five generation controls this stage can honour has not been measured. `generation_control_support.ts` therefore lists none for this task type, and a consumer asking for one is refused rather than answered as though it had asked for nothing.

## Chrome Apps on device permission

The deployed Worker page is served from a Docker container at `https://webai-worker.dash-menu.com`, and connects to the deployed central gateway at `https://webai-gateway.dash-menu.com` by default. Passing `?gatewayUrl=http://localhost:8787` points the deployed Worker page at a gateway running on the local computer instead. Chrome calls that connection an **Apps on device** request because the page is contacting software running on the computer.

Chrome asks for this permission to protect local services from unexpected requests made by websites. Allow the permission when using the deployed Worker with a local gateway. The permission is not needed for downloading model shards from Hugging Face or for using the graphics processor. Select **Reset permission** in Chrome's site information panel to remove the permission; Chrome will ask again the next time the Worker connects to the local gateway.

## Connection lifetime

The page connects to the central gateway as soon as it loads, and keeps that connection for as long as it is the page the browser tab displays. Moving the browser tab to another page closes the connection, so the gateway stops counting this browser as a connected worker and stops giving it work. A browser tab keeps the page it left in its back/forward cache rather than destroying it, so this has to be done as the page is put away; otherwise the page keeps its connection open while nobody is looking at it. Going back to the page opens a new connection, and the gateway registers the worker again under a new device identifier.

Switching to another browser tab is not the same thing as leaving the page: a worker page in a background tab keeps its connection and keeps running the work it has been given.

## Connecting again after the connection is lost

A connection the page did not ask to lose — the gateway was deployed again, its container restarted, the network was interrupted — is opened again on its own, with nobody touching the device. The page waits one second before the first attempt, and longer after each attempt that finds no gateway: two seconds, four, eight, and so on up to one minute, plus a random extra of up to 30 per cent so that every volunteer that was connected to the same gateway does not come back at the same instant. There is no limit on the number of attempts, because a worker browser tab is meant to be left open for hours and the gateway is expected to come back. While it waits, the status badge reads **Connection lost. Trying again in N second(s) (attempt K)**, counting down, so the page is visibly working rather than looking broken.

Both buttons mean something while the page is waiting. **Connect** makes the pending attempt now instead of waiting out the rest of the wait. **Disconnect** stops the page trying at all and leaves this browser disconnected until **Connect** is pressed. A device that gets its network back also makes the pending attempt at once, rather than sitting out a wait that was chosen while there was no network.

Two closes are not followed by another attempt, because trying again would find exactly the same thing and keep finding it once a minute for as long as the tab stays open: a browser that can run none of the stages the loaded pipelines define, and a browser whose model shards could not be loaded. Both leave the page disconnected with **Connect** as the way to ask for another look. See [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).

The wait itself comes from `ReconnectBackoff` in [`@webai/protocol`](../protocol/README.md), shared with [`@webai/worker-openai`](../worker_openai/README.md) and [`@webai/consumer-openai`](../consumer_openai/README.md), so all three lean on one gateway in the same way.

## Quiet tone

A hidden browser tab runs the language model several times slower than one left on screen. The `qwen3_generation_log` experiment in [`@webai/idle-experiments`](../_idle_experiments/README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83), measured about 8.4 tokens per second in a hidden tab against 22.7 on screen — and found that playing a very quiet, continuous tone removes the slowdown entirely, holding 25.7 tokens per second across several minutes hidden.

The worker webpage carries the same tone, in `web/src/page/audio_keepalive.ts`, for [issue #120](https://github.com/webai-at-home/webai-at-home/issues/120). Click **Start quiet tone** to start it; browsers only allow audio to start from a click, so it cannot start on its own as the page loads. Once started, it keeps playing for as long as the page is open, including across reconnections, so a worker browser tab can be moved to the background and left to do volunteer work at full speed.
