# Cost of Model Sharding — Basic Pipeline Model

## Setup

A model \(M\) runs at:

\[
T_{\text{single}} = 20 \text{ tokens/s}
\]

Therefore, the compute time per token on one GPU is:

\[
C = \frac{1}{T_{\text{single}}}
\]

For \(20\) tokens/s:

\[
C = \frac{1}{20} = 50 \text{ ms/token}
\]

Now shard the model evenly across \(S\) identical machines / GPUs.

For \(S = 3\):

\[
M = S_1 + S_2 + S_3
\]

If compute is perfectly balanced:

\[
C_1 = C_2 = C_3 = \frac{C}{3}
\]

So:

\[
C_1 = C_2 = C_3 \approx 16.7 \text{ ms}
\]

Ignoring communication, the latency of one token is still:

\[
C_1 + C_2 + C_3 = C = 50 \text{ ms}
\]

---

## Network latency

Let:

\[
L_{12} = \text{communication latency from machine 1 to machine 2}
\]

\[
L_{23} = \text{communication latency from machine 2 to machine 3}
\]

For one request, token latency becomes approximately:

\[
T_{\text{latency}}
=
C_1 + L_{12} + C_2 + L_{23} + C_3
\]

So sharding increases **per-request latency**.

---

## Full pipeline

With enough independent requests in flight, the three GPUs can work simultaneously:

```text
time →

m1:  R1   R2   R3   R4   R5 ...
      ↓    ↓    ↓    ↓
m2:       R1   R2   R3   R4 ...
           ↓    ↓    ↓
m3:            R1   R2   R3 ...
```

Once the pipeline is full, the ideal output rate is determined by the slowest shard:

\[
T_{\text{aggregate}}
\approx
\frac{1}{\max(C_1,C_2,\ldots,C_S)}
\]

For perfectly balanced shards:

\[
C_i = \frac{C}{S}
\]

therefore:

\[
T_{\text{aggregate}}
\approx
\frac{S}{C}
\]

Since:

\[
T_{\text{single}} = \frac{1}{C}
\]

we obtain:

\[
\boxed{
T_{\text{aggregate}}
\approx
S \times T_{\text{single}}
}
\]

For \(S=3\) and \(T_{\text{single}}=20\) tokens/s:

\[
\boxed{
T_{\text{aggregate}}
\approx
3 \times 20
=
60 \text{ tokens/s}
}
\]

---

## Important result

With balanced shards and enough concurrent requests to keep the pipeline full:

\[
\boxed{
\text{Aggregate throughput}
\approx
S \times \text{single-GPU throughput}
}
\]

In other words, for **aggregate throughput**, \(S\) identical sharded GPUs can ideally behave approximately like one GPU that is \(S\) times faster.

However:

\[
\boxed{
\text{Per-request latency increases}
}
\]

Network latency can often be hidden by pipeline concurrency, **as long as communication itself does not become the throughput bottleneck**.
