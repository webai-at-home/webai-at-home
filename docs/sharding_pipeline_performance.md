# Cost of Model Sharding — Pipeline Performance

A model is split across several machines, one shard per machine, and the machines are personal computers in separate homes joined by WebRTC data channels. This document works out what that costs and what it buys.

It has three parts:

- the ideal pipeline model, which ignores communication and gives the well-known result that `S` shards reach `S` times the throughput of one machine
- the estimation of the real communication latency between two homes, and the assumptions behind it
- what a consumer actually receives, for three usage patterns

---

## Symbols

| Symbol | Meaning |
|---|---|
| `S` | number of shards, one shard per machine |
| `C` | compute time for one token on a single unsharded machine |
| `C_i` | compute time for one token on shard `i`, equal to `C / S` when balanced |
| `L` | one-way communication latency across one hop, from one machine to the next |
| `H` | number of hops per token, equal to `S - 1` |
| `L_total` | total communication latency per token, equal to `H × L` |
| `P` | number of independent requests in flight at the same time |
| `T_single` | token rate of one unsharded machine, equal to `1 / C` |
| `T_token` | latency of one token through the whole pipeline |
| `T_aggregate` | token rate of the whole cluster, counting every request together |

---

## Part 1 — The ideal pipeline model

### Setup

A model runs on one machine at:

\[
T_{\text{single}} = 20 \text{ tokens per second}
\]

so the compute time per token on that one machine is:

\[
C = \frac{1}{T_{\text{single}}} = \frac{1}{20} = 50 \text{ milliseconds per token}
\]

Now shard the model evenly across `S` identical machines. For `S = 3`, if the compute is perfectly balanced:

\[
C_1 = C_2 = C_3 = \frac{C}{3} \approx 16.7 \text{ milliseconds}
\]

Ignoring communication, the latency of one token is unchanged, because the three shards run one after the other:

\[
C_1 + C_2 + C_3 = C = 50 \text{ milliseconds}
\]

### Network latency

Let `L_12` be the communication latency from machine 1 to machine 2, and `L_23` from machine 2 to machine 3. For one request, the latency of one token becomes:

\[
T_{\text{latency}} = C_1 + L_{12} + C_2 + L_{23} + C_3
\]

So sharding increases **per-request latency**.

### Full pipeline

With enough independent requests in flight, the three machines can work at the same time:

```text
time →

m1:  R1   R2   R3   R4   R5 ...
      ↓    ↓    ↓    ↓
m2:       R1   R2   R3   R4 ...
           ↓    ↓    ↓
m3:            R1   R2   R3 ...
```

Once the pipeline is full, the output rate is set by the slowest shard:

\[
T_{\text{aggregate}} \approx \frac{1}{\max(C_1, C_2, \ldots, C_S)}
\]

For perfectly balanced shards, `C_i = C / S`, therefore:

\[
T_{\text{aggregate}} \approx \frac{S}{C} = S \times T_{\text{single}}
\]

For `S = 3` and `T_single = 20` tokens per second, that is **60 tokens per second**.

### The ideal result

With balanced shards and enough concurrent requests to keep the pipeline full, the aggregate throughput is about `S` times the single-machine throughput: `S` sharded machines behave approximately like one machine that is `S` times faster. Against that, the per-request latency increases.

Network latency can be hidden by pipeline concurrency — **as long as communication does not become the bottleneck itself**. The rest of this document measures how far from that condition a cluster of home machines actually sits.

---

## Part 2 — Estimating the real numbers

### How we estimate the compute time per token

The compute time per token comes from a measurement, not from a model of the hardware. One machine runs the whole model and reports its token rate, which gives `C = 50` milliseconds, and dividing by `S` gives `C_i ≈ 16.7` milliseconds.

This is the decode phase only, one token at a time. The prefill phase, which processes the whole prompt in one pass, is not covered here.

### How we estimate the latency between two machines

The two machines are personal computers in two different homes, joined by a WebRTC data channel. The latency of one hop is the sum of several parts, and each part is estimated separately.

| Part of the path | Typical one-way cost | Comment |
|---|---|---|
| Home access link, first hop | 5 to 15 milliseconds | fibre at the low end, cable or digital subscriber line at the high end |
| Wi-Fi, when the machine is not connected with a cable | 3 to 20 milliseconds | also the largest source of jitter |
| Internet path between the two homes, same country | 5 to 20 milliseconds | |
| Datagram Transport Layer Security and Stream Control Transmission Protocol, plus browser scheduling | 2 to 5 milliseconds | packetization and the delay before the event loop runs |
| Serialization of the payload | 1 to 2 milliseconds | see the next section |

Adding the parts gives these one-way totals:

| Situation | One-way latency `L` |
|---|---|
| Both machines connected with a cable, same city, direct peer-to-peer connection | 15 to 25 milliseconds |
| Both machines on Wi-Fi, same country | 30 to 45 milliseconds |
| The two machines on different continents | 90 to 150 milliseconds |
| The connection forced through a TURN (Traversal Using Relays around NAT) relay server | add 20 to 60 milliseconds, because the traffic travels from one machine to the relay server and then to the other machine |

The value used through the rest of this document is the ordinary home case:

\[
L = 35 \text{ milliseconds}
\qquad
H = S - 1 = 2
\qquad
L_{\text{total}} = 70 \text{ milliseconds}
\]

### How we estimate the throughput between two machines

What travels between two shards is the hidden state of a single token. Its size is:

\[
B = \text{hidden dimension} \times \text{bytes per element}
\]

For a model of about 2 billion parameters, the hidden dimension is about 2048, and float16 uses 2 bytes per element:

\[
B = 2048 \times 2 = 4096 \text{ bytes} = 4 \text{ kilobytes}
\]

On a home upload link of 20 megabits per second, the time to put those 4 kilobytes on the wire is:

\[
\frac{4 \times 8 \times 1000}{20 \times 10^{6}} \approx 1.6 \text{ milliseconds}
\]

The conclusion is that bandwidth is not the limit. The payload is small, the serialization time is a rounding error next to the 35 milliseconds of latency, and the sustained bit rate needed is only `B / T_token`, which is about 270 kilobits per second per stream. **The cost of sharding over WebRTC is latency, not bandwidth.**

### Assumptions

These estimates hold only while the following assumptions hold. Each one is stated with what happens when it breaks.

1. **The shards are perfectly balanced.** Every shard takes `C / S`. If one machine is slower, the pipeline advances at the slowest shard, and the aggregate throughput falls to `1 / max(C_i)`.
2. **The machines are identical.** Personal computers in different homes are not identical in practice. One old machine sets the rate for everybody.
3. **Communication and compute do not overlap.** A shard waits for the hidden state before it starts. Overlapping the transfer of one request with the compute of another would hide part of `L`, and is not modelled here.
4. **The latency is a constant `L`, not a distribution.** It is not. Wi-Fi has a long tail, and the pipeline advances at the slowest hop of each token, so the behaviour is closer to the 95th percentile than to the median. A link with a median of 35 milliseconds and a 95th percentile of 120 milliseconds behaves much worse than this document predicts.
5. **The connection is direct, peer to peer.** When a strict router forces the traffic through a TURN relay server, every hop pays the relay detour.
6. **Only the decode phase is counted.** Prefill, the key-value cache, and the sampling step are ignored.
7. **The requests are independent.** Two requests in flight never wait on each other. This is true for separate conversations, and false inside one conversation.
8. **No machine leaves.** A home machine that goes away takes its shard with it, and the whole cluster stops until the shard is placed somewhere else.
9. **The single-machine baseline exists.** Every comparison below is against one machine running the whole model at 20 tokens per second. When the model is sharded because it does not fit on one machine, that baseline is imaginary and the comparison is meaningless.

---

## Part 3 — What a consumer receives

### The two formulas

The latency of one token, through the whole pipeline:

\[
T_{\text{token}} = C + (S - 1) \times L
\]

With the numbers above: `50 + 70` = **120 milliseconds**, so one stream produces about **8.3 tokens per second**.

The aggregate throughput, for `P` independent requests in flight:

\[
T_{\text{aggregate}} = \min\left(\frac{P}{T_{\text{token}}}, \ \frac{S}{C}\right)
\]

The pipeline is full, and the aggregate throughput reaches its ceiling of `S / C`, when:

\[
P \ge \frac{S \times T_{\text{token}}}{C}
= S \times \left(1 + \frac{(S-1) L}{C}\right)
\]

With the numbers above: `3 × 120 / 50` = 7.2, so **8 requests in flight**. Without the network, the same formula gives `S = 3`. The network raises the number of concurrent requests needed to fill the pipeline by the factor `T_token / C`, which is 2.4 here.

The cluster beats one single unsharded machine on total throughput only when:

\[
P > \frac{T_{\text{token}}}{C} = 2.4
\]

so from **3 requests in flight**.

### Usage pattern 1 — one consumer, one request after the other

Token generation is autoregressive: token `n + 1` cannot start before token `n` is finished. A single sequential request therefore never fills the pipeline. At any moment one machine computes and the other two wait.

\[
T_{\text{aggregate}} = \frac{1}{T_{\text{token}}} = \frac{1}{120 \text{ ms}} \approx 8.3 \text{ tokens per second}
\]

Against 20 tokens per second on one unsharded machine, the cluster is **2.4 times slower**. This usage pattern gains nothing from sharding and pays the whole network cost.

### Usage pattern 2 — one consumer, several requests in parallel

The requests are independent, so they can occupy different machines at the same time. Each individual request still runs at 8.3 tokens per second; what grows is the total.

| Requests in flight `P` | Aggregate throughput | Per-request rate |
|---|---|---|
| 1 | 8.3 tokens per second | 8.3 tokens per second |
| 2 | 16.7 tokens per second | 8.3 tokens per second |
| 3 | 25 tokens per second | 8.3 tokens per second |
| 4 | 33 tokens per second | 8.3 tokens per second |
| 8 | 60 tokens per second, the ceiling | 7.5 tokens per second |
| 16 | 60 tokens per second, the ceiling | 3.8 tokens per second, plus queueing |

The consumer reaches the full `S × T_single` only when it is willing to run 8 requests at the same time, and only while accepting that every single one of them feels slower than a single unsharded machine.

### Usage pattern 3 — `S` consumers, one request each

This is `P = S = 3`, which is far short of the 8 requests needed to fill the pipeline.

\[
T_{\text{aggregate}} = \frac{3}{120 \text{ ms}} = 25 \text{ tokens per second}
\]

Each consumer sees 8.3 tokens per second. The three machines together produce 25 tokens per second, against 20 tokens per second for one single unsharded machine — a gain of 25 percent for three times the hardware.

`S` consumers do not fill an `S`-deep pipeline once the network is counted. The number of consumers needed is `S × T_token / C`, which is `S × 2.4` here.

### Summary

| Usage pattern | Requests in flight | Aggregate throughput | Per-request rate | Against one unsharded machine |
|---|---|---|---|---|
| One consumer, sequential | 1 | 8.3 tokens per second | 8.3 tokens per second | 2.4 times slower |
| One consumer, 3 in parallel | 3 | 25 tokens per second | 8.3 tokens per second | 1.25 times faster in total |
| One consumer, 8 in parallel | 8 | 60 tokens per second | 7.5 tokens per second | 3 times faster in total |
| `S` = 3 consumers | 3 | 25 tokens per second | 8.3 tokens per second | 1.25 times faster in total |

Sharding converts latency into throughput, and only under concurrent load. Over WebRTC between homes, `L_total` is larger than `C`, so the network and not the compute sets the token rate. No single stream is ever faster on the sharded cluster than on one machine that can hold the whole model.

---

## What to measure, to replace these estimates

Every number above is an estimate. These four measurements replace the estimates with facts:

1. The one-way latency of the WebRTC data channel between each pair of machines, as a distribution, not a mean — report the median and the 95th percentile.
2. The real size in bytes of the hidden state sent per token, taken from the running code, not from the hidden dimension of the model card.
3. The real per-shard compute time per token on each machine, which shows whether the shards are balanced.
4. The token rate of one machine running the whole model, when the model fits — the baseline that every comparison here depends on.
