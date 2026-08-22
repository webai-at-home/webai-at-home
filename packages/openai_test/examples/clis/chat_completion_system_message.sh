#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Sends a history of several messages, and shows how they become one prompt
###############################################################################
###############################################################################

# Run with: npm run example:cli:chat_completion_system_message --workspace @webai/openai-test
#
# A task in the cluster carries one piece of text, so a history of several messages has to
# become one piece of text before it can be submitted. The rule is:
#
# - one message: its content is sent unchanged;
# - several messages: they are labelled with their roles, one message per line, followed by a
#   final `assistant:` line that invites the answer.
#
# The three messages below therefore reach the worker browser tab as:
#
#   system: Answer in one short sentence, and never use more than ten words.
#   user: What is the capital of France?
#   assistant: Paris is the capital of France.
#   user: And of Italy?
#   assistant:
#
# It needs the gateway running and one worker browser tab open in a recent Chrome whose own
# language model is ready, for example the page
# http://localhost:8787/debug_iframe_llm_gemma_nano_chrome_full.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1
requireJqCommand || exit 1

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

# --message is given once per message, and the messages are sent in the order they are written.
"${openaiCommand}" chat:completions create \
	--model llm_gemma_nano_chrome_full \
	--message '{"role":"system","content":"Answer in one short sentence, and never use more than ten words."}' \
	--message '{"role":"user","content":"What is the capital of France?"}' \
	--message '{"role":"assistant","content":"Paris is the capital of France."}' \
	--message '{"role":"user","content":"And of Italy?"}' \
	--transform 'choices.0.message.content' \
	| jq -r '.'
