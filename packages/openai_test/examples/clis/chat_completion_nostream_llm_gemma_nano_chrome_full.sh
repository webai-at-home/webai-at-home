#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Generates text with the language model built into Chrome, through the cluster
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_nostream_llm_gemma_nano_chrome_full --workspace @webai/openai-test
#
# The model `llm_gemma_nano_chrome_full` is the Gemma Nano language model built into the Chrome
# browser. Nothing about the model is downloaded or held by this project: the worker browser tab
# asks the browser for the answer through the browser's own prompt interface.
#
# It needs the gateway running and one worker browser tab open in a recent Chrome whose own
# language model is ready, for example the page
# http://localhost:8787/debug_iframe_llm_gemma_nano_chrome_full.
#
# The whole answer is generated before this server answers, one piece of the answer per stage
# run, so expect to wait. Ask for --stream true to be answered as the answer is written instead,
# which `examples/clis/chat_completion_streamed_llm_gemma_nano_chrome_full.sh` shows.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_gemma_nano_chrome_full \
	--message '{"role":"user","content":"What is the capital of France? Answer in one short sentence."}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
