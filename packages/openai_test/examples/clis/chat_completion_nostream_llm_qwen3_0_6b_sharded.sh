#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Generates text with Qwen3-0.6B split across three worker browser tabs
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_nostream_llm_qwen3_0_6b_sharded --workspace @webai/openai-test
#
# The model `llm_qwen3_0_6b_sharded` is the Qwen3-0.6B language model split into three
# consecutive shards, each held and run by a different worker browser tab. The three stages
# together produce one token, and the gateway runs them again for each further token, so an
# answer of many tokens is many rounds of three stages.
#
# It needs the gateway running and worker browser tabs that between them offer all three shard
# stages, for example the page http://localhost:8787/debug_iframe_llm_qwen3_0_6b_sharded. The
# three shard files are about 860 megabytes together and are not in version control, so they
# have to be generated once first; `docs/tasks_and_stages.md` says how.
#
# This is the slowest example by a wide margin. The whole answer is generated before this
# server answers, and generation stops at the end-of-sequence token or at 160 tokens.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_qwen3_0_6b_sharded \
	--message '{"role":"user","content":"What is the capital of France?"}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
