#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Carries a real history across two turns, with the complete Gemma 4 E2B instruction-tuned model
###############################################################################
###############################################################################

# Run with:
#   npm run example:cli:chat_completion_history_llm_gemma_4_e2b_full --workspace @webai/openai-test
#
# The model `llm_gemma_4_e2b_full` is one of the three models whose task type accepts a whole
# history rather than only one prompt (`llm_qwen3_5_0_8b_full` and `llm_llama3_2_1b_full` are the
# other two; see `examples/clis/chat_completion_history_llm_qwen3_5_0_8b_full.sh` and
# `examples/clis/chat_completion_history_llm_llama3_2_1b_full.sh`). Sending several messages here
# does not flatten them into lines of `role: content` text the way `llm_gemma_nano_chrome_full`
# and `llm_qwen3_0_6b_sharded` still do — this server submits the messages as they are, and
# `@huggingface/transformers` applies the model's own chat template to real turns.
#
# This example shows what that is worth: the first request states a fact and nothing else, the
# second sends the whole history so far, including the model's own first answer, and asks a
# question that can only be answered by recalling what the first turn said. A caller builds the
# second request's messages itself; this server keeps no history state between requests, so every
# request still carries the whole history.
#
# It needs the gateway running and one worker browser tab open in a browser with a WebGPU adapter
# carrying the `shader-f16` feature, for example the page
# http://localhost:8787/debug_iframe_llm_gemma_4_e2b_full. This stage has no WebAssembly fallback.
# The first request on a fresh browser profile downloads about 3111 MB of model files; later
# requests, including the second one below, reuse the browser's cache.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

model='llm_gemma_4_e2b_full'
firstQuestion='My name is Ada and my favorite programming language is Lisp. Please just say hello back.'
secondQuestion='What is my name, and what is my favorite programming language? Answer in one short sentence.'

# `jq -nc` builds each message as one line of JSON, which keeps a quotation mark or a backslash
# inside the text from breaking the JSON that --message is given.
userMessage() {
	jq -nc --arg content "$1" '{ role: "user", content: $content }'
}
assistantMessage() {
	jq -nc --arg content "$1" '{ role: "assistant", content: $content }'
}

echo "user: ${firstQuestion}"
firstAnswer=$("${openaiCommand}" chat:completions create \
	--model "${model}" \
	--message "$(userMessage "${firstQuestion}")" \
	--transform 'choices.0.message.content' \
	| jq -r '.')
echo "assistant: ${firstAnswer}"

echo "user: ${secondQuestion}"
secondAnswer=$("${openaiCommand}" chat:completions create \
	--model "${model}" \
	--message "$(userMessage "${firstQuestion}")" \
	--message "$(assistantMessage "${firstAnswer}")" \
	--message "$(userMessage "${secondQuestion}")" \
	--transform 'choices.0.message.content' \
	| jq -r '.')
echo "assistant: ${secondAnswer}"
