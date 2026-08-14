# Qwen3-0.6B across browser workers

Milestone four of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), and the first milestone where the network is involved. Qwen3-0.6B generates tokens with its shards spread across four separate browser pages. **Each page keeps the key/value caches for its own layers on its own graphics processor, and only the hidden state crosses between pages.** That property is what makes the whole architecture worth having.

## The pages

One conductor page and four worker pages:

| Page | Graphs it holds |
| --- | --- |
| `decoder_worker_00-11` | decoder layers 0 to 11, as three graphs |
| `decoder_worker_12-19` | decoder layers 12 to 19, as two graphs |
| `decoder_worker_20-27` | decoder layers 20 to 27, as two graphs |
| `head_worker` | the three language-model head chunks, and the token choice |

The head worker chooses the token itself rather than sending logits, because 151936 logits are 608 kilobytes and the token is one number.

The pages talk through a small relay inside this package, at `/relay` in `vite.config.js`, rather than through the cluster's gateway. Issue #179 leaves that choice to this milestone and says the cheaper of the two wins. The relay forwards each frame to the one page named in its header and does nothing else: no routing, no queueing, no retries, no reconnection. Every one of those belongs to the cluster and none of them is what this milestone measures.

## Run

Write the graphs and the decode reference first, as for [`../qwen3-litert-shards/`](../qwen3-litert-shards) and [`../qwen3-litert-resident-decode/`](../qwen3-litert-resident-decode). Then start the development server:

```sh
npm run dev --workspace @webai/litert-experiments
```

Open `qwen3-litert-workers/`, open the four worker links it lists, wait for all four to report ready, and come back to the conductor page to run.

## What it records

Section 24 of [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178) asks for shard index, mode, position, input bytes, output bytes, inference milliseconds and serialization milliseconds per shard execution. The conductor prints one row per graph, and one row per relay hop. Sending and receiving are recorded separately, by whichever page did each, and joined by the conductor, because no single page sees both ends of a hop.

## What it found

**Reading tensors back is where the time goes, not computing them and not the relay.** Across 360 graph executions, inference was about 0.9 milliseconds each and reading the output back was 12 to 17. Five relay hops cost about 3 milliseconds a token against 155 to 200 milliseconds of decode.

Two warnings go with that split. `run()` queues work and returns before the graphics processor has finished, so the first read after it absorbs the remaining wait — "readback" is a synchronisation, not a copy cost, and the two numbers mean something only added together. And the payloads are tiny: 4096 bytes for a hidden state. Twelve milliseconds to move four kilobytes is not a transfer rate.
