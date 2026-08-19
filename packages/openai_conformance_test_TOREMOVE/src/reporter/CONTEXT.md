# Directory Context: `/packages/openai_conformance_test/src/reporter`

## Purpose

One file per output format section 33 of issue #181 names with `-f/--format`, plus the one place the counts behind every format are worked out.

## Key Exports & Entry Points

- `report_summary.ts`: `ReportSummary`, the counts and the compatibility percentage every format shows.
- `report_parameters.ts`: `ReportParameters`, which lists what a run was given and rebuilds its command line, both without the bearer token.
- `terminal.ts`: `TerminalReporter`, the `text` format a person reads, including the feature matrix of section 31.
- `json.ts`: `JsonReporter`, the `json` format another program reads.
- `markdown.ts`: `MarkdownReporter`, the `markdown` format a report file holds.
- `junit.ts`: `JunitReporter`, the `junit` format a continuous integration run already knows how to read.

## Rules

- A reporter renders `TestRunRecord[]` from `../runner.ts` into a string; it never runs a test and never talks to an endpoint.
- `render` returns the report as a string rather than printing it, so a test can assert on the returned text and `cli.ts` is the only place that calls `console.log`.
- No reporter counts verdicts itself; every one of them asks `ReportSummary`, so four formats of one run can never disagree about how many tests passed.
- `SKIP` stays out of the compatibility percentage and `WARN` stays in it, because a skipped test measured nothing while a warned test measured something short of correct.
- The compatibility percentage never replaces the per-test lines above it, per section 30 of issue #181; a reporter that only printed the percentage would not satisfy this rule.
- The bearer token never reaches a reporter in readable form: `report_parameters.ts` replaces it before the parameter list or the command line is handed over, because a markdown report is written to be published and a reporter must not be the place that decides what is safe to print.
- `markdown.ts` puts the summary above the group tables, and stamps every report with a generation date, so a report file found later says how old it is and what produced it before it says what came out.
- A format that builds a document with reserved characters escapes them itself — the vertical bar and the newline for `markdown.ts`, the five XML characters for `junit.ts` — because a test detail quotes whatever the endpoint sent back.
- `junit.ts` writes `WARN` as a passing case carrying a note, never as `<failure>`, so a continuous integration run does not go red on a result this package deliberately does not call a failure.

## Background

- The feature matrix comes from section 31 of issue #181, which calls a per-capability answer more useful to a reader than one overall percentage.
