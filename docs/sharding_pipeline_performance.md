# Cost of Model Sharding — Pipeline Performance

A model is split across several machines, one shard per machine, and the machines are personal computers in separate homes joined by WebRTC data channels. This document works out what that costs and what it buys.

It has three parts:

- the ideal pipeline model, which ignores communication and gives the well-known result that `shard_count` shards reach `shard_count` times the throughput of one machine
- the estimation of the real communication latency between two homes, and the assumptions behind it
- what a consumer actually receives, for three usage patterns

---

## Variables

| Variable | Meaning |
|---|---|
| `shard_count` | number of shards, one shard per machine |
| `model_compute_time` | compute time for one token on a single unsharded machine |
| `shard_compute_time` | compute time for one token on one shard, equal to `model_compute_time / shard_count` when balanced |
| `hop_latency` | one-way communication latency across one hop, from one machine to the next |
| `hop_count` | number of hops per token, equal to `shard_count`, because the token returns from the last shard to the first |
| `network_latency` | total communication latency per token, equal to `hop_count × hop_latency` |
| `request_count` | number of independent requests in flight at the same time |
| `single_machine_rate` | token rate of one unsharded machine, equal to `1 / model_compute_time` |
| `token_latency` | latency of one token through the whole pipeline |
| `cluster_throughput` | token rate of the whole cluster, counting every request together |
| `payload_size` | bytes of hidden state sent between two shards, for one token |
| `hidden_dimension` | width of the hidden state of the model |
| `element_size` | bytes per element of the hidden state |
| `upload_bandwidth` | upload speed of a home internet link |
| `serialization_time` | time to put one payload on the wire |

---

## Part 1 — The ideal pipeline model

### Setup

A model runs on one machine at:

```text
single_machine_rate = 20 tokens per second
```

so the compute time per token on that one machine is:

```text
model_compute_time = 1 / single_machine_rate
                   = 1 / 20
                   = 50 milliseconds per token
```

Now shard the model evenly across `shard_count` identical machines. For `shard_count = 3`, if the compute is perfectly balanced:

```text
shard_compute_time = model_compute_time / 3
                   = 16.7 milliseconds
```

Ignoring communication, the latency of one token is unchanged, because the three shards run one after the other:

```text
3 × shard_compute_time = model_compute_time = 50 milliseconds
```

### Network latency

Decoding is a ring, not a line. The hidden state travels from machine 1 to machine 2, then to machine 3, and the token that machine 3 produces must travel **back to machine 1** before the next token can start. A pipeline of `shard_count` shards therefore pays `shard_count` hops per token, not `shard_count - 1`.

Let `first_hop_latency` be the latency from machine 1 to machine 2, `second_hop_latency` from machine 2 to machine 3, and `return_hop_latency` from machine 3 back to machine 1. For one request, the latency of one token becomes:

```text
token_latency = shard_compute_time
              + first_hop_latency
              + shard_compute_time
              + second_hop_latency
              + shard_compute_time
              + return_hop_latency
```

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

```text
cluster_throughput ≈ 1 / max(shard_compute_time over every shard)
```

For perfectly balanced shards, `shard_compute_time = model_compute_time / shard_count`, therefore:

```text
cluster_throughput ≈ shard_count / model_compute_time
                   = shard_count × single_machine_rate
```

For `shard_count = 3` and `single_machine_rate = 20` tokens per second, that is **60 tokens per second**.

### The ideal result

With balanced shards and enough concurrent requests to keep the pipeline full, the cluster throughput is about `shard_count` times the single-machine rate: `shard_count` sharded machines behave approximately like one machine that is `shard_count` times faster. Against that, the per-request latency increases.

Network latency can be hidden by pipeline concurrency — **as long as communication does not become the bottleneck itself**. The rest of this document measures how far from that condition a cluster of home machines actually sits.

---

## Part 2 — Estimating the real numbers

### How we estimate the compute time per token

The compute time per token comes from a measurement, not from a model of the hardware. One machine runs the whole model and reports its token rate, which gives `model_compute_time = 50` milliseconds, and dividing by `shard_count` gives `shard_compute_time ≈ 16.7` milliseconds.

This is the decode phase only, one token at a time. The prefill phase, which processes the whole prompt in one pass, is not covered here.

### How we estimate the latency between two machines

The two machines are personal computers in two different homes, joined by a WebRTC data channel. The `hop_latency` of one hop is the sum of several parts, and each part is estimated separately.

| Part of the path | Typical one-way cost | Comment |
|---|---|---|
| Home access link, first hop | 5 to 15 milliseconds | fibre at the low end, cable or digital subscriber line at the high end |
| Wi-Fi, when the machine is not connected with a cable | 3 to 20 milliseconds | also the largest source of jitter |
| Internet path between the two homes, same country | 5 to 20 milliseconds | |
| Datagram Transport Layer Security and Stream Control Transmission Protocol, plus browser scheduling | 2 to 5 milliseconds | packetization and the delay before the event loop runs |
| `serialization_time` of the payload | 1 to 2 milliseconds | see the next section |

Adding the parts gives these one-way totals:

| Situation | `hop_latency` |
|---|---|
| Both machines connected with a cable, same city, direct peer-to-peer connection | 15 to 25 milliseconds |
| Both machines on Wi-Fi, same country | 30 to 45 milliseconds |
| The two machines on different continents | 90 to 150 milliseconds |
| The connection forced through a TURN (Traversal Using Relays around NAT) relay server | add 20 to 60 milliseconds, because the traffic travels from one machine to the relay server and then to the other machine |

The values used through the rest of this document are the ordinary home case:

```text
hop_latency     = 35 milliseconds
hop_count       = shard_count = 3
network_latency = hop_count × hop_latency = 105 milliseconds
```

### How we estimate the throughput between two machines

What travels between two shards is the hidden state of a single token. Its size is:

```text
payload_size = hidden_dimension × element_size
```

For a model of about 2 billion parameters, `hidden_dimension` is about 2048, and float16 gives an `element_size` of 2 bytes:

```text
payload_size = 2048 × 2
             = 4096 bytes
             = 4 kilobytes
```

On a home link with an `upload_bandwidth` of 20 megabits per second, the time to put those 4 kilobytes on the wire is:

```text
serialization_time = (4 × 8 × 1000) / (20 × 10^6)
                   ≈ 1.6 milliseconds
```

The conclusion is that bandwidth is not the limit. The payload is small, the `serialization_time` is a rounding error next to the 35 milliseconds of `hop_latency`, and the sustained bit rate needed is only `payload_size / token_latency`, which is about 210 kilobits per second per stream. **The cost of sharding over WebRTC is latency, not bandwidth.**

### Assumptions

These estimates hold only while the following assumptions hold. Each one is stated with what happens when it breaks.

1. **The shards are perfectly balanced.** Every shard takes `model_compute_time / shard_count`. If one machine is slower, the pipeline advances at the slowest shard, and the cluster throughput falls to `1 / max(shard_compute_time)`.
2. **The machines are identical.** Personal computers in different homes are not identical in practice. One old machine sets the rate for everybody.
3. **Communication and compute do not overlap.** A shard waits for the hidden state before it starts. Overlapping the transfer of one request with the compute of another would hide part of `hop_latency`, and is not modelled here.
4. **The `hop_latency` is a constant, not a distribution.** It is not. Wi-Fi has a long tail, and the pipeline advances at the slowest hop of each token, so the behaviour is closer to the 95th percentile than to the median. A link with a median of 35 milliseconds and a 95th percentile of 120 milliseconds behaves much worse than this document predicts.
5. **The connection is direct, peer to peer.** When a strict router forces the traffic through a TURN relay server, every hop pays the relay detour.
6. **Only the decode phase is counted.** Prefill, the key-value cache, and the sampling step are ignored.
7. **The requests are independent.** Two requests in flight never wait on each other. This is true for separate conversations, and false inside one conversation.
8. **No machine leaves.** A home machine that goes away takes its shard with it, and the whole cluster stops until the shard is placed somewhere else.
9. **The single-machine baseline exists.** Every comparison below is against one machine running the whole model at 20 tokens per second. When the model is sharded because it does not fit on one machine, that baseline is imaginary and the comparison is meaningless.

---

## Part 3 — What a consumer receives

### The two formulas

The latency of one token, through the whole pipeline:

```text
token_latency = model_compute_time + shard_count × hop_latency
              = 50 + 3 × 35
              = 155 milliseconds
```

so one stream produces about **6.5 tokens per second**, and spends 68 percent of its time on the network.

The cluster throughput, for `request_count` independent requests in flight:

```text
cluster_throughput = min(request_count / token_latency,
                         shard_count / model_compute_time)
```

The pipeline is full, and the cluster throughput reaches its ceiling of `shard_count / model_compute_time`, when:

```text
request_count ≥ shard_count × token_latency / model_compute_time
              = shard_count × (1 + shard_count × hop_latency / model_compute_time)
```

With the numbers above, `3 × 155 / 50` = 9.3, so **10 requests in flight**. Without the network, the same formula gives `shard_count`, which is 3. The network raises the number of concurrent requests needed to fill the pipeline by the factor `token_latency / model_compute_time`, which is 3.1 here.

The cluster beats one single unsharded machine on total throughput only when:

```text
request_count > token_latency / model_compute_time = 3.1
```

so from **4 requests in flight**.

### Usage pattern 1 — one consumer, one request after the other

Token generation is autoregressive: token `n + 1` cannot start before token `n` is finished. A single sequential request therefore never fills the pipeline. At any moment one machine computes and the other two wait.

```text
cluster_throughput = 1 / token_latency
                   = 1 / 155 milliseconds
                   ≈ 6.5 tokens per second
```

Against 20 tokens per second on one unsharded machine, the cluster is **3.1 times slower**. This usage pattern gains nothing from sharding and pays the whole network cost.

### Usage pattern 2 — one consumer, several requests in parallel

The requests are independent, so they can occupy different machines at the same time. Each individual request still runs at 6.5 tokens per second; what grows is the total.

| `request_count` | `cluster_throughput` | Per-request rate |
|---|---|---|
| 1 | 6.5 tokens per second | 6.5 tokens per second |
| 2 | 12.9 tokens per second | 6.5 tokens per second |
| 3 | 19.4 tokens per second | 6.5 tokens per second |
| 4 | 25.8 tokens per second | 6.5 tokens per second |
| 8 | 51.6 tokens per second | 6.5 tokens per second |
| 10 | 60 tokens per second, the ceiling | 6.0 tokens per second |
| 16 | 60 tokens per second, the ceiling | 3.8 tokens per second, plus queueing |

The consumer reaches the full `shard_count × single_machine_rate` only when it is willing to run 10 requests at the same time, and only while accepting that every single one of them feels slower than a single unsharded machine.

### Usage pattern 3 — `shard_count` consumers, one request each

This is `request_count = shard_count = 3`, which is far short of the 10 requests needed to fill the pipeline.

```text
cluster_throughput = 3 / 155 milliseconds
                   = 19.4 tokens per second
```

Each consumer sees 6.5 tokens per second. The three machines together produce 19.4 tokens per second, against 20 tokens per second for one single unsharded machine — **three machines and three home internet links, to end up very slightly slower than one machine.**

`shard_count` consumers do not fill a pipeline of `shard_count` shards once the network is counted. The number of consumers needed is `shard_count × token_latency / model_compute_time`, which is `shard_count × 3.1`, so 10 here.

### Summary

| Usage pattern | `request_count` | `cluster_throughput` | Per-request rate | Against one unsharded machine |
|---|---|---|---|---|
| One consumer, sequential | 1 | 6.5 tokens per second | 6.5 tokens per second | 3.1 times slower |
| One consumer, 3 in parallel | 3 | 19.4 tokens per second | 6.5 tokens per second | very slightly slower in total |
| One consumer, 10 in parallel | 10 | 60 tokens per second | 6.0 tokens per second | 3 times faster in total |
| `shard_count` = 3 consumers | 3 | 19.4 tokens per second | 6.5 tokens per second | very slightly slower in total |

Sharding converts latency into throughput, and only under concurrent load. Over WebRTC between homes, `network_latency` is twice `model_compute_time`, so the network and not the compute sets the token rate. No single stream is ever faster on the sharded cluster than on one machine that can hold the whole model.

---

## What to measure, to replace these estimates

Every number above is an estimate. These four measurements replace the estimates with facts:

1. The `hop_latency` of the WebRTC data channel between each pair of machines, as a distribution, not a mean — report the median and the 95th percentile.
2. The real `payload_size` in bytes sent per token, taken from the running code, not from the `hidden_dimension` of the model card.
3. The real `shard_compute_time` on each machine, which shows whether the shards are balanced.
4. The `single_machine_rate` of one machine running the whole model, when the model fits — the baseline that every comparison here depends on.
