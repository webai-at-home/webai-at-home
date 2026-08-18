# `vendor/` — the Gemma 4 E2B WebGPU compute kernel bundle

`gemma-4-e2b.js` is copied, byte for byte and unchanged, from the Hugging Face Space
[`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/tree/main),
downloaded on 2026-08-18 from
`https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/raw/main/gemma-4-e2b.js`.
It is 551802 bytes.

The bundle holds the whole model: the tokenizer, the chat template, the WebGPU Shading Language compute kernels as
Jinja templates, and the code that writes the weights to a WebGPU device and runs the generation. It imports nothing.
There is no model runtime between it and the graphics processor — no ONNX Runtime Web, no Transformers.js, and no
LiteRT.js. That is the whole point of this experiment.

It downloads the weights from
[`google/gemma-4-E2B-it-qat-mobile-transformers`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers),
which is ungated and whose `model.safetensors` is 2458111846 bytes.

`gemma-4-e2b.d.ts` is written by hand, and declares the part of the bundle this experiment calls. It is not generated.
When `gemma-4-e2b.js` is updated, `gemma-4-e2b.d.ts` is checked against the new bundle by hand.

## What is not copied from the Hugging Face Space

- `index.html` — the page of the Hugging Face Space. This experiment writes its own page, in the folder above this one.
- `landing.js` — a decorative animation drawn with the `three` library. It draws the Hugging Face Space landing page
  and holds no part of the model, so this experiment does not need it and does not take on a `three` dependency for it.
- `README.md` — the Hugging Face Space frontmatter only.
