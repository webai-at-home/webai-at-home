#!/usr/bin/env bash
set -euo pipefail

###############################################################################
###############################################################################
#	Asks this server which models the cluster offers
###############################################################################
###############################################################################

# Run with: npm run example:cli:list_models --workspace @webai/openai-test
#
# This is the cheapest example. It reaches this server only, so it answers even when no
# gateway is running and no volunteer browser is connected.
#
# `openai models list` reads the whole list for you, one model object per line of output,
# so an empty list prints nothing at all.

# `find_openai_command.sh` says why the program is looked up rather than simply called.
source "$(dirname "${BASH_SOURCE[0]}")/find_openai_command.sh"
openaiCommand=$(findOpenaiCommand) || exit 1

# This server requires no key unless it was started with --api-key, and the openai command line
# program refuses to run without one, so a placeholder is passed here.
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://localhost:8788/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-no-key-required}"

"${openaiCommand}" models list
