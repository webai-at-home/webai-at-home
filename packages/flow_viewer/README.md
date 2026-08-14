# `@webai/flow-viewer`

`flow_viewer` loads recorded gateway message logs and displays the message flow
between consumers, the gateway, and worker browsers.

## Run

```sh
npm run flow_viewer --workspace @webai/flow-viewer
```

The command scans the gateway's own log directory, `~/.webai-at-home/gateway/logs`, for files named
`gateway-*.log_entry.jsonl`, serves the flow viewer page, and opens the page in
a browser. Use `--no-open` to keep the browser closed, or pass one or more
`.log_entry.jsonl` files explicitly.

Useful options include `--logs-dir <dir>`, `--from <datetime>`,
`--to <datetime>`, `--chatter`, `--signaling`, `--speed <multiplier>`,
`--no-autoplay`, and `--port <number>`. Port `0` chooses a free port. Run
`npm run flow_viewer --workspace @webai/flow-viewer -- --help` for the full
list.

The former `cli` script remains available as a compatibility alias.

Build, type check, and test the package with:

```sh
npm run build --workspace @webai/flow-viewer
npm run typecheck --workspace @webai/flow-viewer
npm run test --workspace @webai/flow-viewer
```
