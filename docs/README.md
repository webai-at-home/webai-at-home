# Documents

The reference documents for `webai-at-home`. Each document below is the one authoritative place for its subject, so a fact that is written in one of them is not repeated in the others.

## How the cluster works

- [`tasks_and_stages.md`](tasks_and_stages.md) — every kind of task the cluster can run, what each kind of task does, and every stage the cluster carries out to finish it.
- [`protocol_by_role.md`](protocol_by_role.md) — the WebSocket messages the gateway, the consumers, and the workers exchange, listed by the actor that sends each one.
- [`naming_scheme.md`](naming_scheme.md) — how every task, task type, pipeline, and stage name is built, and what each part of a name means.
- [`accounting_system.md`](accounting_system.md) — how contributed and consumed computation are recorded: what an account is, what a credit is, and what the ledger holds.

## How to configure and measure it

- [`environment_variables.md`](environment_variables.md) — which environment variables exist, which program reads each one, and how a variable relates to the command line option that configures the same thing.
- [`openai_api_conformance.md`](openai_api_conformance.md) — which parts of the OpenAI Chat Completions protocol this project's OpenAI-compatible server honours, measured against the local model server it forwards to.
- [`sharding_pipeline_performance.md`](sharding_pipeline_performance.md) — what splitting a model across several machines in separate homes costs in communication latency, and what it buys in throughput.

## Blog posts

- [`blog_posts/`](blog_posts/README.md) — a written introduction to `webai-at-home`, from the idea to the architecture to the interface to the open question about browser tab throttling. Four posts, each one a `.blog_post.md` file with its cover image in [`blog_posts/images/`](blog_posts/images).
