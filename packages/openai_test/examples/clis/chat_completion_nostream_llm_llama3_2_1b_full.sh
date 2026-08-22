#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Generates text with the complete Llama 3.2 1B Instruct model, through the cluster
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_nostream_llm_llama3_2_1b_full --workspace @webai/openai-test
#
# The model `llm_llama3_2_1b_full` is the complete Llama 3.2 1B Instruct language model,
# downloaded directly from Hugging Face (onnx-community/Llama-3.2-1B-Instruct-ONNX, an ONNX
# export of meta-llama/Llama-3.2-1B-Instruct) and held entirely by one worker browser tab.
#
# It needs the gateway running and one worker browser tab open in a browser with WebGPU and
# 16-bit float shader support, for example the page
# http://localhost:8787/debug_iframe_llm_llama3_2_1b_full. The first request on a fresh browser
# profile downloads about 1050 MB of model files; later requests reuse the browser's cache.
#
# The whole answer is generated before this server answers, one piece of the answer per stage
# run, so expect to wait. Ask for --stream true to be answered as the answer is written instead,
# which `examples/clis/chat_completion_streamed_llm_llama3_2_1b_full.sh` shows.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_llama3_2_1b_full \
	--message '{"role":"user","content":"What is the capital of France? Answer in one short sentence."}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
