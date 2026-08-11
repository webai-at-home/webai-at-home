# Change One Line

This is the third and last post in a series about `webai-at-home`, a project that borrows idle browser tabs to run a language model.

The [first post](./post_1_inference_without_permission.blog_post.md) made the argument: paying a company and buying a graphics card are both forms of permission, and the computing capacity to avoid both is already sitting in people's homes doing nothing. The [second post](./post_2_designing_for_workers_that_disappear.blog_post.md) went through the architecture that falls out of assuming every worker can vanish mid-computation.

Neither of those is worth anything on its own. A system can be philosophically sound and technically survivable and still be a curiosity, because nobody is going to rewrite their software to use it.

So this post is about the part that decides whether any of it matters:

```python
client = OpenAI(base_url="http://localhost:8788/v1", api_key="unused")
```

That is the whole integration. Any program already written against OpenAI can run its work on a cluster of volunteer browser tabs by changing its base address and nothing else.

> The complete project is open source: [github.com/webai-at-home/webai-at-home](https://github.com/webai-at-home/webai-at-home)

![Change One Line](images/post_3_change_one_line.png)

## Why the Interface Is the Argument

It is tempting to file this under "convenience layer, added at the end". I want to argue the opposite: this is where the thesis of the entire project either survives or collapses.

Independence that costs a rewrite is not independence. If moving off a paid service means changing how your software is structured, then in practice you are not free to move, and the fact that an alternative exists somewhere is irrelevant to you. The provider's real hold is not their model. It is their integration surface.

Which means the interface is the actual permission boundary. The moment an unusual backend is reachable through the ordinary one, the unusual part stops being a commitment and becomes a runtime setting. You can point at a data centre today and at a room full of old laptops tomorrow, and the code does not care. That, and not the model quality, is what makes the choice genuinely yours.

There is also an unglamorous version of the same point: I get the entire existing tool ecosystem for free, and I did not have to ask anybody's permission to have it.

Here is the least impressive possible demonstration, which needs no model download at all — the arithmetic pipeline from post 1, reached through the OpenAI interface:

```sh
curl http://localhost:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"dev_formula","messages":[{"role":"user","content":"5"}]}'
```

The answer is seventeen, computed across two browser tabs, delivered in the shape of a chat completion.

## What the Adapter Actually Has to Reconcile

The OpenAI interface was designed for one always-available server that answers immediately. Underneath it here is a batch-oriented cluster of borrowed devices that appear and disappear. Those two models disagree in specific places, and each disagreement needs a decision.

**A history has to become one piece of text.** A task in this cluster carries a single prompt, so a multi-message history is flattened: one message per line labelled with its role, followed by a final `assistant:` line inviting the answer. A request carrying exactly one message is passed through completely unchanged — which is also what makes the arithmetic model usable, since it accepts a number and nothing else. And because a task is one request, the server keeps no history state at all: the whole history is resubmitted every time.

**Streaming is a request, not a default.** This one is a genuine architectural consequence rather than a formatting choice. The cluster does not stream internally. A task that did not ask for pieces has its answer produced in as few scheduling rounds as the pipeline can manage. A task that *did* ask for pieces costs a full scheduling round — a message to the coordinator and a message back — for every piece of the answer.

So streaming is not free here the way it is when a server is already producing tokens and merely deciding when to flush them. It is a real change in how much coordination traffic the answer costs. That is why `stream: true` is a per-request choice rather than something the cluster always does, and it is a good example of a distributed system's internals showing through an interface that was not designed to express them.

**Failures need a vocabulary that predates them.** Every failure comes back in the standard OpenAI error shape, so the official client library raises the error it would raise against OpenAI itself. But some of the things that can go wrong here have no counterpart in a data centre:

| What happened | Status | Code |
| --- | --- | --- |
| No volunteer browser offered the work before the deadline | 503 | `no_volunteer_available` |
| The cluster ran the task and the task failed | 502 | `task_failed` |
| This server is not connected to the coordinator | 503 | `gateway_unavailable` |
| The task did not finish in time and was cancelled | 504 | `request_timed_out` |

`no_volunteer_available` is my favourite error in the project, because it is the one that could not exist in any other system. It does not mean anything is broken. It means nobody happened to have the right tab open.

There is also a case with no clean answer. If a request fails *after* the first streamed chunk has gone out, the HTTP status line has already been sent and cannot be taken back. The error is written into the stream as a `data:` line carrying the same error body, and the stream is closed. It is the least bad option rather than a good one.

## What It Deliberately Does Not Do

I would rather state the limits than let you discover them.

- **It reports no token usage.** The coordinator reports no token counts to a consumer, so this server has none — and it states none rather than inventing plausible ones. An invented `usage` field would be worse than a missing one, because somebody would eventually bill against it.
- **It ignores every generation setting except `stream`.** `temperature`, `top_p`, `max_tokens`, `n`, `stop`, `tools` and the rest are accepted and then ignored, because a task input currently carries only a prompt and whether the answer is wanted in pieces. The real limits are the browser tab's own: 160 tokens for the sharded Qwen3-0.6B pipeline, 400 pieces of an answer for the Chrome built-in model.
- **It refuses messages made of multiple parts**, which is what a request carrying an image or audio sends, rather than silently joining them into something the cluster would answer wrongly.
- **It serves two endpoints, not the whole interface.** Chat completions and a model list.

"OpenAI-compatible" is a claim people make very loosely. This is the honest version of it: enough of the interface that real client libraries work, and an explicit list of what is not there.

One detail I am quietly pleased with: the models on offer are derived from the cluster's own task type names, with the `task_type_` prefix removed. The catalogue cannot drift away from what the cluster can actually run, because it is not a second list — it is the same list, spelled differently.

## Measuring It Honestly

A claim like "volunteer devices can do useful work" deserves a number rather than a paragraph, so the package includes a benchmark.

It sends the same streamed prompt twice: once directly to a local model server, then to this OpenAI-compatible server backed by *the same model on the same machine*. Requests run strictly one at a time, so the first comparison contains no parallel scheduling effects. What is left in the difference is the coordination overhead — the cost of routing through a coordinator and a worker rather than calling the model directly.

It measures five things, all observable from the client side with no knowledge of the model or its tokenizer:

- **Time to First Character** — how responsive it feels.
- **Time to Last Character** — end-to-end latency.
- **Output Characters per Second** — streaming speed after the first character.
- **Input Characters** and **Output Characters** — the size of what went in and came out.

Characters rather than tokens is a deliberate choice. Token counts are not comparable across providers unless you know each one's tokenizer, and one of these two endpoints does not report token counts at all. Characters are the honest common denominator. The measurement even degrades gracefully: an endpoint that ignores the streaming request and answers in one piece has its first and last character arrive at the same instant, so the two times simply become equal.

```sh
npm run benchmark --workspace @webai/consumer-openai -- --runs 10
```

> **To fill in before publishing:** paste your actual figures here, with the machine and model named, and say plainly what the coordination overhead costs. Publish them even if they are unflattering — a slow number with an explanation is far more convincing than no number at all.

## The Measurement That Decides Whether Any of This Works

There is one open question underneath the whole project that I have been measuring separately, because if it goes the wrong way, nothing above matters.

Volunteer work happens in a tab nobody is looking at. And a backgrounded tab in Chrome is deliberately slowed down — that is a feature, built to stop the tabs you forgot about from draining your battery. If it slows the tab too much, a volunteer's contribution is worthless in exactly the situation where volunteering is meant to happen.

So before changing any production code to work around it, I built a set of measurement pages that do nothing but watch what a tab actually does as it moves between focused, visible-but-unfocused, and backgrounded: how far a nominal one-second timer drifts, how many animation frames land between ticks, and how long a fixed amount of raw computation takes.

Then variations on the same measurement, each testing one documented escape route:

- The identical computation run on the main thread and in a dedicated background worker at once, in one combined log, so they can be compared under the same conditions.
- The same measurement with a very quiet continuous tone playing, because Chrome documents that audio-playing contexts are exempt from background timer throttling.
- The same measurement with two peer connections in the same page talking only to each other, because that same documented exemption also covers real-time connections.
- A local browser extension running the measurement in a hidden document that belongs to no tab or window at all — so there is nothing to background, cover, or minimize in the first place.

Every variation is built on the same calibration measurement, so results are comparable page by page: run one focused, backgrounded, and in a small corner window, then repeat with another page and see whether the escape route actually changed the numbers.

I am spelling this out because it is the part of the project I would most like people to argue with, and because it is the opposite of how the rest of the industry discusses browser inference. The interesting question is not what a browser can do in a benchmark on a focused tab. It is what a browser will still do for you when nobody is watching it.

## What Is Still Open

In the spirit of not overselling:

- **Verification.** A volunteer returns some numbers. How do I know they ran the model instead of returning plausible noise? Today I do not. For a system built on strangers' devices, this is the largest unsolved problem here.
- **Trust in the other direction.** Volunteers can see the prompts they are asked to work on. Anyone submitting sensitive text to a cluster of strangers should understand exactly that, and "should understand" is not a design.
- **Partitioning across unequal devices.** Cutting Qwen3-0.6B at layers 9 and 19 is a fixed split chosen by hand. Sizing the pieces to what each volunteer's device can actually hold is a much harder problem, and it is the one standing between small models and useful ones.

The current state is small models: Qwen3-0.6B across three tabs, Chrome's built-in Gemma Nano, the complete Qwen3.5-0.8B in one tab, and — since a worker turns out not to have to be a browser at all — a local model server joining the cluster as a worker.

That is not yet an answer to the permission problem. It is a demonstration that every part of the path exists: a client that does not know it is talking to volunteers, a coordinator that survives them leaving, and browser tabs that hold a model between them.

The hardware is already out there, switched on, doing nothing. What has been missing is a way to use it that nobody has to approve. This is my attempt at one, and it is at [github.com/webai-at-home/webai-at-home](https://github.com/webai-at-home/webai-at-home) if you want to take it apart.
