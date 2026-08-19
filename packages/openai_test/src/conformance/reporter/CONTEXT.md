# Directory Context: `/packages/openai_test/src/conformance/reporter`

## Purpose

One file per output format section 33 of issue #181 names with `-f/--format`, plus the one place the counts behind every format are worked out.

## Key Exports & Entry Points

- `report_summary.ts`: `ReportSummary`, the counts and the compatibility percentage every format shows.
- `terminal.ts`: `TerminalReporter`, the `text` format a person reads, including the feature matrix of section 31.
- `json.ts`: `JsonReporter`, the `json` format another program reads.
- `markdown.ts`: `MarkdownReporter`, the `markdown` format a report file holds.
- `junit.ts`: `JunitReporter`, the `junit` format a continuous integration run already knows how to read.
- `merged_records.ts`: `MergedRecords`, which lays one model's runs back out as the one record list the four reporters read.

## Rules

- A reporter renders the records of `../runner.ts` into a string; it never runs a test and never talks to an endpoint.
- One invocation measures one model and writes one report, however many runs it took, its runs merged by `merged_records.ts` before any format sees them.
- `render` returns the report as a string rather than printing it, so `../../report_writer.ts` is the only place that prints one.
- No reporter decides a verdict's word or its color itself; `terminal.ts` asks [`../verdict_style.ts`](../verdict_style.ts), which the live progress lines read as well.
- No reporter counts verdicts itself; every one of them asks `ReportSummary`, so four formats of one run can never disagree about how many tests passed.
- `SKIP` stays out of the compatibility percentage and `WARN` stays in it, because a skipped test measured nothing while a warned test measured something short of correct.
- The compatibility percentage never replaces the per-test lines above it, per section 30 of issue #181.
- The bearer token never reaches a reporter in readable form: [`../../report_parameters.ts`](../../report_parameters.ts) replaces it first, because a markdown report is written to be published.
- `markdown.ts` puts the summary above the group tables, and stamps every report with a generation date, so a report file found later says how old it is.
- A format that builds a document with reserved characters escapes them itself — the vertical bar and the newline for `markdown.ts`, the five XML characters for `junit.ts` — because a test detail quotes whatever the endpoint sent back.
- `junit.ts` writes `WARN` as a passing case carrying a note, never as `<failure>`, so a continuous integration run does not go red on a result this package deliberately does not call a failure.

## Background

- The feature matrix comes from section 31 of issue #181, which calls a per-capability answer more useful to a reader than one overall percentage.
