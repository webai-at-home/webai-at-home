#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Runs the development formula task through the OpenAI responses interface
###############################################################################
###############################################################################

# Run with: npm run example:cli:responses_dev_formula --workspace @webai/openai-test
#
# This server answers two interfaces, and this is the only example here that uses the second
# one. `openai beta:responses create` posts to /v1/responses, where every other example here
# posts to /v1/chat/completions. Both run the same task and return the same answer; they differ
# only in the shape of the request and of the answer.
#
# It needs the gateway running and at least one worker browser tab open, for example the page
# http://localhost:8787/debug_iframe_dev_formula, which opens the two tabs the task uses.
#
# The number is written as '"5"', with the quotation marks inside the single quotation marks,
# because the openai command line program reads the value of --input as JSON. Writing --input 5
# would send the JSON number 5, which /v1/responses refuses, and only the quoted form sends the
# JSON string "5" that the development formula task reads as a number.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

# The answer of /v1/responses carries its text further down than the answer of
# /v1/chat/completions does: one list of output items, each one holding a list of content parts.
"${openaiCommand}" beta:responses create \
	--model dev_formula \
	--input '"5"' \
	--transform 'output.0.content.0.text' \
	| jq -r '.'
