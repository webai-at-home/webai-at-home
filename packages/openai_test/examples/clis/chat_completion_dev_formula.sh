#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Runs the development formula task through the OpenAI completion interface
###############################################################################
###############################################################################

# Run with: npm run example:cli:chat_completion_dev_formula --workspace @webai/openai-test
#
# This is the example to run first. The model `dev_formula` is the cluster's development
# formula task: it multiplies the submitted number by two in one stage and adds seven in the
# next, so the number 5 comes back as 17. It downloads no model and needs no graphics
# processor, so it proves the whole path — this server, the central gateway, stage scheduling
# across two worker browser tabs, and the answer — with nothing else in the way.
#
# It needs the gateway running and at least one worker browser tab open, for example the page
# http://localhost:8787/debug_iframe_dev_formula, which opens the two tabs the task uses.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

# A request carrying one message sends that message's content unchanged, which is what lets
# this model receive a number. Several messages would be labelled with their roles and joined,
# and the resulting text would not be a number.
#
# `--transform` picks one value out of the answer with a GJSON path, and `jq -r` prints that
# value as plain text rather than as a quoted JSON string.
"${openaiCommand}" chat:completions create \
	--model dev_formula \
	--message '{"role":"user","content":"5"}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
