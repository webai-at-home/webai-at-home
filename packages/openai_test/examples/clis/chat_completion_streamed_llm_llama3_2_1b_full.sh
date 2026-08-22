#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Shows the complete Llama 3.2 1B Instruct model answer arriving as it is written
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_streamed_llm_llama3_2_1b_full --workspace @webai/openai-test
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
# A request that asks for --stream true is answered as the answer is written, as server-sent
# events: one chunk per piece of the answer, ended by a `[DONE]` line. The openai command line
# program prints every chunk as it arrives, and `jq --unbuffered -j` writes the piece out of each
# one with no line break between them, which reassembles the answer on screen as it is written.
#
# The piece is taken with `// empty` rather than with the --transform flag, because the first and
# the last chunk of a stream carry no piece at all: the first announces the role and the last
# announces the reason generation stopped. --transform prints the whole chunk when its path finds
# nothing, so those two chunks would appear on screen as raw JSON around the answer.
#
# Asking for a stream is what makes the cluster send pieces at all. It costs a scheduling round
# for every piece, so a request that does not ask for one is answered with the fewest messages the
# pipeline can manage, which `examples/clis/chat_completion_nostream_llm_llama3_2_1b_full.sh` shows.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_llama3_2_1b_full \
	--message '{"role":"user","content":"What is the capital of France?"}' \
	--stream true \
	| jq --unbuffered -j '.choices[0].delta.content // empty'
echo
