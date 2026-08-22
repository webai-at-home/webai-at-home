#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Shows Qwen3-0.6B split across three worker browser tabs answering as it is written
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_streamed_llm_qwen3_0_6b_sharded --workspace @webai/openai-test
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
# Every piece here is one token, which is the smallest piece this model produces regardless of
# whether a stream was asked for, so streaming costs no extra scheduling round for this model the
# way it does for `examples/clis/chat_completion_streamed_llm_gemma_nano_chrome_full.sh`.
#
# This is the slowest example by a wide margin. Generation stops at the end-of-sequence token or
# at 160 tokens.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" chat:completions create \
	--model llm_qwen3_0_6b_sharded \
	--message '{"role":"user","content":"What is the capital of France?"}' \
	--stream true \
	| jq --unbuffered -j '.choices[0].delta.content // empty'
echo
