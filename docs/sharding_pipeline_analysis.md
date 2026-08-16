# Analysis of the Sharding Pipeline Performance Document

This document reviews [sharding_pipeline_performance.md](sharding_pipeline_performance.md). It does not repeat that document's derivations. It records one arithmetic error, one framing that must be dropped, and four effects that dominate the real cluster and are missing.

---

## The two scope facts that change everything

The performance document is written as if two things were open questions. They are not.

**The model is larger than the memory of any single graphics processor.** Sharding is not chosen for speed; it is the only way the model runs. The performance document acknowledges this in its assumption 9 and then compares against a 20 tokens per second single-machine baseline on every page anyway.

**The load is batch work: massively parallel and mostly non-interactive.** Many independent requests are queued at once and nobody watches a single answer appear. The performance document is built around three interactive usage patterns, two of which describe a situation that does not occur.

Together these make the figure of merit a single number: **the aggregate tokens per second of the whole cluster, under a deep queue.** Per-request latency is not a figure of merit, and neither is any comparison against one machine.

---

## Finding 1 — The hop count is wrong: `H = S`, not `S - 1`

This is an arithmetic error, independent of the scope question.

Decoding is a ring, not a line. The last shard produces token `n`, and that token must travel back to the first shard before token `n + 1` can start. The loop closes, so a three-shard pipeline pays **three** hops per token, not two.

\[
T_{\text{token}} = C + S \times L = 50 + 3 \times 35 = 155 \text{ milliseconds}
\]

not the 120 milliseconds the performance document gives. Consequences:

| Quantity | Performance document | Corrected |
|---|---|---|
| Latency of one token | 120 milliseconds | 155 milliseconds |
| Rate of a single stream | 8.3 tokens per second | 6.5 tokens per second |
| Requests in flight to fill the pipeline | 8 | 10 |
| Share of the token spent on the network | 58 percent | 68 percent |

Under batch load the change in the first two rows costs nothing that anyone feels. The change in the third row is the one that matters, for the reason given in finding 3.

---

## Finding 2 — The single-machine baseline must be removed, not corrected

Because the model does not fit on one machine, "20 tokens per second on one unsharded machine" describes something that cannot be run. Every entry in the performance document's final column — "2.4 times slower", "1.25 times faster in total" — measures against a machine that does not exist. It reads as a verdict of failure on what is in fact the only working configuration.

The honest comparisons are:

- one machine running the model with the weights spilling into system memory or onto disk, which is real and very slow
- not running the model at all

Against the second, 6.5 tokens per second for an otherwise unrunnable model is a good outcome, and the same number the performance document frames as a threefold loss.

---

## Finding 3 — Key-value cache memory caps the requests in flight, and this is the binding limit

The performance document treats the requests in flight as a free choice — "the consumer reaches the full rate only when it is willing to run 8 requests at the same time". Under batch load the queue is deep by assumption, so willingness is never the constraint. **Memory is.**

Sharding was forced by the weights not fitting. Whatever memory remains after the weights must then hold a key-value cache for every request in flight, on every shard, growing with each request's context length:

\[
\text{cache per token} = 2 \times \text{layers} \times \text{key-value dimension} \times \text{bytes per element}
\]

For a model of about 2 billion parameters with 28 layers, the answer turns on whether the model uses grouped-query attention:

| Attention style | Key-value dimension | Per token | Per request at 4096 tokens | Per shard, `S` = 3 |
|---|---|---|---|---|
| Grouped-query attention, 4 key-value heads of 128 | 512 | 57 kilobytes | about 235 megabytes | about 78 megabytes |
| Full multi-head attention | 2048 | 229 kilobytes | about 940 megabytes | about 313 megabytes |

With 2 gigabytes free on each machine after its share of the weights, and a corrected fill requirement of 10 requests:

- **grouped-query attention: about 25 requests fit.** Above 10, so the cluster reaches its ceiling of 60 tokens per second.
- **full multi-head attention: about 6 requests fit.** Below 10, so the cluster tops out at `6 / 155 ms` ≈ **39 tokens per second** and never fills the pipeline, however deep the queue.

The same cluster either reaches its ceiling or misses it by a third, decided entirely by the attention style and the context length. At 16384 tokens of context the grouped-query attention case also falls to about 6 requests.

There is an unpleasant interaction with finding 1. Higher latency raises the number of requests needed to fill the pipeline, and those extra requests cost memory the cluster does not have. **Slow links and small memory fail together**, and the performance document, by undercounting the hops, understates both halves.

---

## Finding 4 — Batching inside a shard breaks the ceiling of `S / C`

Every formula in the performance document assumes a shard handles one request at a time, which makes `S / C` a hard ceiling. A graphics processor running eight requests as one batched matrix multiplication takes far less time than eight separate passes, because decode is limited by reading the weights out of memory and one read serves the whole batch.

For batch work this is not an optimization but the design. Two consequences:

- the real aggregate throughput can go well above `S × T_single`, so every figure in the performance document is a lower bound rather than an estimate
- the batch size and the requests in flight compete for the same memory measured in finding 3, so the two must be sized together

---

## Finding 5 — Prefill is a large share of batch work, and it behaves in the opposite way

The performance document covers the decode phase only. Non-interactive batch work is frequently long input and short output — classification, extraction, summarization — so the omitted phase may be most of the compute. Prefill inverts both of the document's conclusions:

- **Prefill fills the pipeline on its own.** A prompt of `N` tokens is processed in one pass, splittable into chunks that flow through the shards together, so a single request keeps every machine busy. None of the requests-in-flight arithmetic applies.
- **Prefill is where bandwidth finally bites.** The performance document concludes that bandwidth is irrelevant, which is right for decode: 4 kilobytes per token, about 1.9 megabits per second per machine at the ceiling. During prefill the payload is `N × 4` kilobytes. For a 1000-token prompt that is 4 megabytes per hop, which on a 20 megabit per second home upload link is about **1.6 seconds** of serialization — the largest single term anywhere in either document, and one the performance document dismisses in a bold sentence.

Any usable estimate must count prefill and decode separately.

---

## Finding 6 — Machines leave in the middle of long jobs

A batch running for hours across home computers will lose a machine. The shard goes with it and every request in flight dies, not only the requests of whoever owned that machine. The performance document mentions this once, as assumption 8. For batch work it is a throughput term: the effective rate is the ceiling multiplied by the fraction of started work that survives to completion.

---

## Finding 7 — One assumption is safer than the document claims

The performance document's assumption 4 warns that latency is a distribution with a long Wi-Fi tail, and that the pipeline advances at the slowest hop, so the behaviour approaches the 95th percentile.

That is correct for interactive use and largely wrong for batch use. Under a full pipeline with a queue at each shard, jitter is absorbed rather than amplified: a hop that arrives late finds work already waiting. **This is the one place where the batch case is easier than the document says.**

---

## What stops mattering

Under the batch scope, these parts of the performance document describe situations that do not occur and should be reduced to a short note rather than kept as three of its sections:

- **Usage pattern 1, one consumer sending one request after the other.** Only reached when the queue has dried up.
- **Usage pattern 3, `S` consumers with one request each.** A special case of "not enough requests in flight", with no special significance.
- **The per-request rate column** throughout. Nobody is waiting.

The note worth keeping is that a cluster built for batch work must not be presented as an interactive one: a human waiting on a single answer gets 6.5 tokens per second, adding consumers does not help any individual consumer, and human users are idle enough that the requests in flight average near 1 rather than near 10.

---

## Corrected results

With `S = 3`, `C_i = 16.7` milliseconds, `L = 35` milliseconds, `H = 3`, one request per shard step:

| Requests in flight | Aggregate throughput | Reached when |
|---|---|---|
| 1 | 6.5 tokens per second | the queue has dried up |
| 6 | 39 tokens per second | full multi-head attention caps the memory here |
| 10 | 60 tokens per second, the ceiling | grouped-query attention with a short context |
| more than 10 | 60 tokens per second, plus queueing | no further gain without batching inside the shard |

For batch work the cluster is a reasonable machine: about 60 tokens per second on a model no single member could load at all. Reaching that needs 10 requests in flight rather than the 8 the performance document gives, and whether the memory holds 10 is decided by the attention style and the context length. The network costs 105 of the 155 milliseconds per token, which nobody feels directly, but which reappears as the memory needed to hide it.

---

## What to measure, in order of how much it would change these conclusions

1. **The key-value cache bytes per request per shard, and the free memory on each machine after the weights.** These give the largest number of requests that fit, which decides whether the ceiling is reachable at all.
2. **The prefill throughput and the real bytes per hop during prefill**, the term most likely to be underestimated.
3. **The one-way latency of each WebRTC data channel**, as a distribution — median and 95th percentile, not a mean.
4. **The per-shard compute time per token on each machine**, which shows whether the shards are balanced.
5. **The rate at which machines leave**, and the fraction of started requests that finish.
