# Analysis of the Sharding Pipeline Performance Document

This document reviews [sharding_pipeline_performance.md](sharding_pipeline_performance.md). It does not repeat that document's derivations. It records one arithmetic error, since corrected in that document, one framing that must be dropped, and four effects that dominate the real cluster and are missing.

---

## Variables

The variables of the performance document are used unchanged. This document adds the following.

| Variable | Meaning |
|---|---|
| `fill_request_count` | requests in flight needed to keep every machine busy |
| `memory_request_count` | largest number of requests that fit in memory at the same time |
| `layer_count` | number of layers in the model |
| `key_value_dimension` | width of the key and value vectors stored per token |
| `cache_per_token` | key-value cache bytes for one token of context, across the whole model |
| `cache_per_request` | key-value cache bytes for one request, across the whole model |
| `shard_cache_size` | key-value cache bytes for one request on one shard |
| `free_memory` | memory left on a machine after its share of the weights |
| `context_length` | tokens of context held by one request |
| `prompt_length` | tokens in the prompt, during prefill |
| `batch_size` | requests processed together in one pass inside a shard |
| `completion_fraction` | fraction of started requests that survive machine churn to completion |

---

## The two scope facts that change everything

The performance document is written as if two things were open questions. They are not.

**The model is larger than the memory of any single graphics processor.** Sharding is not chosen for speed; it is the only way the model runs. The performance document acknowledges this in its assumption 9 and then compares against a `single_machine_rate` of 20 tokens per second on every page anyway.

**The load is batch work: massively parallel and mostly non-interactive.** Many independent requests are queued at once and nobody watches a single answer appear. The performance document is built around three interactive usage patterns, two of which describe a situation that does not occur.

Together these make the figure of merit a single number: **the `cluster_throughput` under a deep queue.** Per-request latency is not a figure of merit, and neither is any comparison against one machine.

---

## Finding 1 — The hop count was wrong: `hop_count` equals `shard_count`, not `shard_count - 1`

**This one is fixed. The performance document now carries the corrected arithmetic, and the numbers quoted in the rest of this analysis match it.** The finding is kept here as the record of what changed.

Decoding is a ring, not a line. The last shard produces token `n`, and that token must travel back to the first shard before token `n + 1` can start. The loop closes, so a three-shard pipeline pays **three** hops per token, not two.

```text
hop_count     = shard_count
token_latency = model_compute_time + shard_count × hop_latency
              = 50 + 3 × 35
              = 155 milliseconds
```

not the 120 milliseconds the performance document originally gave. What the correction moved:

| Quantity | Before the correction | After |
|---|---|---|
| `network_latency` | 70 milliseconds | 105 milliseconds |
| `token_latency` | 120 milliseconds | 155 milliseconds |
| Rate of a single stream | 8.3 tokens per second | 6.5 tokens per second |
| `fill_request_count` | 8 | 10 |
| Share of the token spent on the network | 58 percent | 68 percent |
| Three consumers, one request each | 25 tokens per second, a gain over one machine | 19.4 tokens per second, a loss against one machine |

Under batch load the first three rows cost nothing that anyone feels. The change in `fill_request_count` is the one that matters, for the reason given in finding 3.

---

## Finding 2 — The single-machine baseline must be removed, not corrected

Because the model does not fit on one machine, a `single_machine_rate` of 20 tokens per second describes something that cannot be run. Every entry in the performance document's final column — "3.1 times slower", "very slightly slower in total" — measures against a machine that does not exist. It reads as a verdict of failure on what is in fact the only working configuration.

The honest comparisons are:

- one machine running the model with the weights spilling into system memory or onto disk, which is real and very slow
- not running the model at all

Against the second, 6.5 tokens per second for an otherwise unrunnable model is a good outcome, and the same number the performance document frames as a threefold loss.

---

## Finding 3 — The key-value cache caps the requests in flight, and this is the binding limit

The performance document treats `request_count` as a free choice — "the consumer reaches the full rate only when it is willing to run 10 requests at the same time". Under batch load the queue is deep by assumption, so willingness is never the constraint. **Memory is.**

Sharding was forced by the weights not fitting. Whatever `free_memory` remains after the weights must then hold a key-value cache for every request in flight, on every shard, growing with `context_length`:

```text
cache_per_token   = 2 × layer_count × key_value_dimension × element_size
cache_per_request = cache_per_token × context_length
shard_cache_size  = cache_per_request / shard_count
```

For a model of about 2 billion parameters with a `layer_count` of 28, the answer turns on whether the model uses grouped-query attention:

| Attention style | `key_value_dimension` | `cache_per_token` | `cache_per_request` at a `context_length` of 4096 | `shard_cache_size`, `shard_count` = 3 |
|---|---|---|---|---|
| Grouped-query attention, 4 key-value heads of 128 | 512 | 57 kilobytes | about 235 megabytes | about 78 megabytes |
| Full multi-head attention | 2048 | 229 kilobytes | about 940 megabytes | about 313 megabytes |

With a `free_memory` of 2 gigabytes on each machine, and a `fill_request_count` of 10:

```text
memory_request_count = free_memory / shard_cache_size
```

- **grouped-query attention: `memory_request_count` ≈ 25.** Above 10, so the cluster reaches its ceiling of 60 tokens per second.
- **full multi-head attention: `memory_request_count` ≈ 6.** Below 10, so the cluster tops out at `6 / 155 ms` ≈ **39 tokens per second** and never fills the pipeline, however deep the queue.

The same cluster either reaches its ceiling or misses it by a third, decided entirely by the attention style and the `context_length`. At a `context_length` of 16384 the grouped-query attention case also falls to a `memory_request_count` of about 6.

There is an unpleasant interaction with finding 1. A higher `hop_latency` raises `fill_request_count`, and those extra requests cost memory the cluster does not have. **Slow links and small memory fail together**, which is why the `hop_count` correction of finding 1 matters here and nowhere else.

---

## Finding 4 — Batching inside a shard breaks the ceiling

Every formula in the performance document assumes a shard handles one request at a time, which makes `shard_count / model_compute_time` a hard ceiling. A graphics processor running a `batch_size` of eight requests as one batched matrix multiplication takes far less time than eight separate passes, because decode is limited by reading the weights out of memory and one read serves the whole batch.

For batch work this is not an optimization but the design. Two consequences:

- the real `cluster_throughput` can go well above `shard_count × single_machine_rate`, so every figure in the performance document is a lower bound rather than an estimate
- `batch_size` and `request_count` compete for the same memory measured in finding 3, so the two must be sized together

---

## Finding 5 — Prefill is a large share of batch work, and it behaves in the opposite way

The performance document covers the decode phase only. Non-interactive batch work is frequently long input and short output — classification, extraction, summarization — so the omitted phase may be most of the compute. Prefill inverts both of the document's conclusions:

- **Prefill fills the pipeline on its own.** A prompt of `prompt_length` tokens is processed in one pass, splittable into chunks that flow through the shards together, so a single request keeps every machine busy. None of the `fill_request_count` arithmetic applies.
- **Prefill is where bandwidth finally bites.** The performance document concludes that bandwidth is irrelevant, which is right for decode: a `payload_size` of 4 kilobytes per token, about 1.9 megabits per second per machine at the ceiling. During prefill the payload is `prompt_length × payload_size`. For a `prompt_length` of 1000 that is 4 megabytes per hop, which on an `upload_bandwidth` of 20 megabits per second gives a `serialization_time` of about **1.6 seconds** — the largest single term anywhere in either document, and one the performance document dismisses in a bold sentence.

Any usable estimate must count prefill and decode separately.

---

## Finding 6 — Machines leave in the middle of long jobs

A batch running for hours across home computers will lose a machine. The shard goes with it and every request in flight dies, not only the requests of whoever owned that machine. The performance document mentions this once, as assumption 8. For batch work it is a throughput term: the effective rate is the ceiling multiplied by `completion_fraction`.

---

## Finding 7 — One assumption is safer than the document claims

The performance document's assumption 4 warns that `hop_latency` is a distribution with a long Wi-Fi tail, and that the pipeline advances at the slowest hop, so the behaviour approaches the 95th percentile.

That is correct for interactive use and largely wrong for batch use. Under a full pipeline with a queue at each shard, jitter is absorbed rather than amplified: a hop that arrives late finds work already waiting. **This is the one place where the batch case is easier than the document says.**

---

## What stops mattering

Under the batch scope, these parts of the performance document describe situations that do not occur and should be reduced to a short note rather than kept as three of its sections:

- **Usage pattern 1, one consumer sending one request after the other.** Only reached when the queue has dried up.
- **Usage pattern 3, `shard_count` consumers with one request each.** A special case of "not enough requests in flight", with no special significance.
- **The per-request rate column** throughout. Nobody is waiting.

The note worth keeping is that a cluster built for batch work must not be presented as an interactive one: a human waiting on a single answer gets 6.5 tokens per second, adding consumers does not help any individual consumer, and human users are idle enough that `request_count` averages near 1 rather than near 10.

---

## Results under the batch scope

These agree with the performance document now that finding 1 is applied there. What they add is the `memory_request_count` row, which the performance document does not model at all.

With `shard_count` = 3, `shard_compute_time` = 16.7 milliseconds, `hop_latency` = 35 milliseconds, `hop_count` = 3, and a `batch_size` of 1:

| `request_count` | `cluster_throughput` | Reached when |
|---|---|---|
| 1 | 6.5 tokens per second | the queue has dried up |
| 6 | 39 tokens per second | full multi-head attention caps `memory_request_count` here |
| 10 | 60 tokens per second, the ceiling | grouped-query attention with a short `context_length` |
| more than 10 | 60 tokens per second, plus queueing | no further gain without raising `batch_size` |

For batch work the cluster is a reasonable machine: about 60 tokens per second on a model no single member could load at all. Reaching that needs a `request_count` of 10, and whether the memory holds 10 is decided by the attention style and the `context_length`. The network costs 105 of the 155 milliseconds of `token_latency`, which nobody feels directly, but which reappears as the memory needed to hide it.

---

## What to measure, in order of how much it would change these conclusions

1. **`shard_cache_size` and `free_memory` on each machine.** These give `memory_request_count`, which decides whether the ceiling is reachable at all.
2. **The prefill throughput and the real bytes per hop during prefill**, the term most likely to be underestimated.
3. **`hop_latency` on each WebRTC data channel**, as a distribution — median and 95th percentile, not a mean.
4. **`shard_compute_time` on each machine**, which shows whether the shards are balanced.
5. **`completion_fraction`**, and the rate at which machines leave.
