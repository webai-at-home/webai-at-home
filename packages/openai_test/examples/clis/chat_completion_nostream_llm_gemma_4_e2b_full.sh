#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Generates text with the complete Gemma 4 E2B instruction-tuned model, through the cluster
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_nostream_llm_gemma_4_e2b_full --workspace @webai/openai-test
#
# The model `llm_gemma_4_e2b_full` is the complete Gemma 4 E2B instruction-tuned language model,
# downloaded directly from Hugging Face (onnx-community/gemma-4-E2B-it-ONNX, an ONNX export of
# google/gemma-4-E2B-it) and held entirely by one worker browser tab.
#
# It needs the gateway running and one worker browser tab open, for example the page
# http://localhost:8787/debug_iframe_llm_gemma_4_e2b_full. That tab needs more than any other
# example here asks for:
#
# - A WebGPU adapter with the `shader-f16` feature. This stage has no WebAssembly fallback at all,
#   because WebAssembly is far too slow to carry a model of this size. A tab without one does not
#   offer the stage, and this example is then refused for want of a worker rather than answered
#   some slower way.
# - About 3111 MB of free origin storage for the first request on a fresh browser profile, which
#   is roughly three times what `llm_llama3_2_1b_full` downloads. Later requests reuse the
#   browser's cache. An embedded browser view will not do: it caps an origin well below this.
#
# The whole answer is generated before this server answers, one piece of the answer per stage
# run, so expect to wait. Ask for --stream true to be answered as the answer is written instead,
# which `examples/clis/chat_completion_streamed_llm_gemma_4_e2b_full.sh` shows.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_gemma_4_e2b_full \
	--message '{"role":"user","content":"What is the capital of France? Answer in one short sentence."}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
