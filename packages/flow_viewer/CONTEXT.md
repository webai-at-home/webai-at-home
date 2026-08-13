# Directory Context: `/packages/flow_viewer`

## Purpose

Loads recorded gateway message logs and displays the message flow between consumers, the central gateway, and worker browsers on a timeline that can be played back.

## Key Exports & Entry Points

- `src/cli.ts`: the `flow_viewer` command line program. It scans `packages/gateway/logs` for files named `gateway-*.log_entry.jsonl`, serves the page, and opens a browser. Command to run this folder: `npm run flow_viewer --workspace @webai/flow-viewer`.
- `web/index.html` and `web/src/flow_viewer_app.ts`: the page itself, built by Vite.
- `web/src/log_entry_parser.ts`: reads a `.log_entry.jsonl` file into the page's own types.
- `web/src/timeline_model.ts` and `web/src/timeline_view.ts`: the timeline, separated into the data and the drawing of it.

## Rules

- This package only reads. It never connects to a running gateway, and it never writes a log file.
- `src/` is the Node.js command line program and `web/` is the browser page: command line code must not import from `web/`, and page code must not import from `src/`.
- The message log file format is defined by `message_logger.ts` in `@webai/protocol`. When that format changes, `web/src/log_entry_parser.ts` is what has to follow.
- Keep the timeline data in `web/src/timeline_model.ts` and the drawing in `web/src/timeline_view.ts`. Do not compute timeline positions inside the view.

## Background

- The log files this package reads are written by the gateway; see [`packages/gateway`](../gateway) for where they are kept and how that location is set.
