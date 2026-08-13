# Directory Context: `/packages/_idle_experiments`

## Purpose

Browser experiments about idle time: what a tab's timers, animation frames, and raw computation actually do as the tab moves between focused, visible but unfocused, and backgrounded.

## Key Exports & Entry Points

- `public/index.html`: the home page linking to every experiment. Command to run this folder: `npm run dev --workspace @webai/idle-experiments`.
- `public/visibility_timer_log/`: how timers and animation frames slow down as the tab is backgrounded.
- `public/web_worker_cpu_log/`: whether raw computation in a Web Worker is throttled with the tab.
- `public/silent_audio_log/`: whether a quiet, near-inaudible tone keeps a backgrounded tab at full speed.
- `public/worker_audio_combo_log/`: the Web Worker and the quiet tone together.
- `public/qwen3_generation_log/`: real generation with the Qwen3 model, backgrounded and not.
- `public/webrtc_datachannel_log/`: whether a browser-to-browser data channel is throttled.
- `extension/offscreen_audio_log/`: the same question asked from a browser extension with an offscreen document.

## Rules

- The leading underscore marks this package as an experiment. It is private, is not part of the root build script, and no working package may import from it.
- This package deliberately does not depend on `@webai/onnx-experiments` either, so each can be read and run without the other.
- Each experiment is standalone. The repeated `idle_probe.ts` and `ui_helper.ts` files are copies on purpose; do not merge them.
- `npm test --workspace @webai/idle-experiments` runs the type check only. What these experiments produce is a measurement a person reads, not an assertion.
- The findings are written up in [`post_4_the_tab_nobody_is_watching.blog_post.md`](../../docs/blog_posts/post_4_the_tab_nobody_is_watching.blog_post.md). Update it when a new measurement changes the conclusion.

## Background

- These experiments come from [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83): a worker browser tab is meant to sit in the background, and a backgrounded tab in Chrome runs measurably slower.
