#!/bin/bash
# Starts the gateway and a static file server for the built worker page, translating environment
# variables into the command line options each program reads (neither of the two reads
# environment variables directly). See packages/docker_server/README.md for what each variable
# configures.
#
# The OpenAI-compatible server from packages/consumer_openai is deliberately not started here:
# one deployment of that server is one account, and every task it submits is debited to that one
# account whoever called its OpenAI-compatible endpoint, so running it in a publicly reachable
# container makes the operator of this container pay for everybody else's consumption. Anyone who
# wants an OpenAI-compatible endpoint runs consumer_openai themselves, with their own account key
# file, pointing --gateway-url at this gateway. See issue #139.
set -euo pipefail

GATEWAY_PORT="${GATEWAY_PORT:-8787}"
GATEWAY_AUTH_TOKEN="${GATEWAY_AUTH_TOKEN:-development-token}"
GATEWAY_STATE_FILE="${GATEWAY_STATE_FILE:-/data/gateway-state.json}"
GATEWAY_ACCOUNT_FILE="${GATEWAY_ACCOUNT_FILE:-/data/gateway-accounts.json}"
GATEWAY_LEDGER_FILE="${GATEWAY_LEDGER_FILE:-/data/gateway-ledger.jsonl}"
GATEWAY_TRUST_REVERSE_PROXY="${GATEWAY_TRUST_REVERSE_PROXY:-false}"

WORKER_PORT="${WORKER_PORT:-8789}"

# Baked into the image at build time as the ENV COMMIT_SHA instruction in the Dockerfile, from
# the SOURCE_COMMIT build argument. Falls back to "unknown" only for an image built without
# that argument.
COMMIT_SHA="${COMMIT_SHA:-unknown}"

gateway_pid=""
worker_pid=""

shutdown() {
	trap - TERM INT
	for pid in "$gateway_pid" "$worker_pid"; do
		[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	exit 0
}
trap shutdown TERM INT

# A container reached through a reverse proxy — which is every container reached over TLS on a
# domain name — sees that proxy on every connection, so the address of the device connecting is
# only in the x-forwarded-for header the proxy sets. The gateway believes that header solely when
# it is told a proxy is in front, because any client can write it. See issue #183.
gateway_reverse_proxy_options=()
if [ "$GATEWAY_TRUST_REVERSE_PROXY" = "true" ]; then
	gateway_reverse_proxy_options=(--trust-reverse-proxy)
fi

node packages/gateway/dist/cli.js \
	--port "$GATEWAY_PORT" \
	--auth-token "$GATEWAY_AUTH_TOKEN" \
	--state-file "$GATEWAY_STATE_FILE" \
	--account-file "$GATEWAY_ACCOUNT_FILE" \
	--ledger-file "$GATEWAY_LEDGER_FILE" \
	--commit-sha "$COMMIT_SHA" \
	${gateway_reverse_proxy_options[@]+"${gateway_reverse_proxy_options[@]}"} &
gateway_pid=$!

node packages/docker_server/src/static_server.mjs packages/worker_webpage/dist "$WORKER_PORT" &
worker_pid=$!

set +e
wait -n "$gateway_pid" "$worker_pid"
exit_code=$?
set -e
echo "One of the servers exited (code $exit_code); shutting down the rest" >&2
shutdown
