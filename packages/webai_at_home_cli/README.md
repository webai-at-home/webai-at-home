# `webai-at-home`

The single command line program published to the npm registry as `webai-at-home`, so a user runs `npx webai-at-home <command>` to run one participant of the WebAI@Home cluster without cloning this repository. It dispatches to the other four command line programs in this repository — [`@webai/gateway`](../gateway/README.md), [`@webai/consumer-openai`](../consumer_openai/README.md), [`@webai/worker-openai`](../worker_openai/README.md), and [`@webai/consumer-cli`](../consumer_cli/README.md) — rather than reimplementing any of them. See [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170).

## Run with `npx`

```sh
npx webai-at-home gateway
npx webai-at-home worker_openai --model llama-3.2-1b-instruct
npx webai-at-home submit --task_type llm_llama3_2_1b_full "What is the capital of France?"
```

The worker above expects an OpenAI-compatible server, such as [LM Studio](https://lmstudio.ai), already running on `http://localhost:1234/v1`, which is that address's default and so needs no `--openai-base-url`. LM Studio loads the named model on demand, so it does not have to be loaded first. Run `npx webai-at-home <command> --help` for a command's own options — every option a command line program in this repository already has, `--port`, `--gateway-url`, `--config_dir`, and the rest, works the same way through `npx webai-at-home`.

## Which program runs

The first word of the command line decides:

| First word | Runs |
| --- | --- |
| `gateway` | [`@webai/gateway`](../gateway/README.md), the central gateway |
| `consumer_openai` | [`@webai/consumer-openai`](../consumer_openai/README.md), the OpenAI-compatible server |
| `worker_openai` | [`@webai/worker-openai`](../worker_openai/README.md), the native worker |
| anything else | [`@webai/consumer-cli`](../consumer_cli/README.md), on the whole command line unchanged |

## `--version`

```sh
npx webai-at-home --version
```

`npx` fetches whichever version of this package the npm registry currently holds, and prints nothing about which one that was, so this is what a bug report should quote.

"Anything else" covers every `consumer_cli` subcommand — `submit`, `status`, `capacity`, `log_statistics`, and the account commands — and a global option such as `--gateway-url` written ahead of one of them, since `consumer_cli` is what reads it. See each program's own README, linked above, for its own options.

## Build

```sh
npm run build --workspace webai-at-home
```

Building this package on its own does not build the four programs it wraps: `npm run build:dependencies --workspace webai-at-home` builds all four first, and `prepack` runs both before `npm pack` or `npm publish` packs anything, so packing never depends on having built by hand first.

For local checks, also run:

```sh
npm run typecheck --workspace webai-at-home
npm run test --workspace webai-at-home
```

## How a real install gets all five programs from one published package

None of `@webai/gateway`, `@webai/consumer-openai`, `@webai/worker-openai`, `@webai/consumer-cli`, or `@webai/protocol` is published to the npm registry on its own — `webai-at-home` is the only package this repository publishes. `scripts/vendor_wrapped_programs.ts` copies each of the four wrapped programs' own built output, plus a copy of `@webai/protocol` and, where needed, `@webai/consumer-cli`, into this package's own `dist/vendor` as part of `prepack`, and rewrites `dist/cli.js` to import each one from its vendored copy instead of by package name. See [`CONTEXT.md`](CONTEXT.md) for why a plain copy replaced npm's own `bundledDependencies` mechanism, and what `scripts/vendor_wrapped_programs.ts` copies where.
