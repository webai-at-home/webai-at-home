#!/usr/bin/env bash

###############################################################################
###############################################################################
#	findOpenaiCommand — names the official OpenAI command line program to run
###############################################################################
###############################################################################

# Every example in this folder sources this file and then runs "${openaiCommand}" rather than
# plain `openai`, for one reason: two different programs are called `openai` on this machine.
#
# - The one this folder is written against is the official OpenAI command line program,
#   https://developers.openai.com/api/docs/libraries/openai-cli, installed with
#   `brew install openai/tools/openai`. It answers `--version` with a line starting
#   `openai version`.
# - The `openai` npm package installs a program of the same name into `node_modules/.bin`. It is
#   a helper that migrates code from version 3 to version 4 of that package, and it can send no
#   request at all.
#
# `npm run` puts `node_modules/.bin` at the front of the PATH, so plain `openai` inside an
# `example:cli:*` script finds the migration helper and the example fails with
# `Unknown subcommand`. Asking every `openai` on the PATH for its version, and keeping the first
# one that answers as the official program does, finds the right one whether the example was
# started by `npm run` or run directly from a shell.
#
# It also reports the two programs the examples need, so a missing one is said in words rather
# than found out through a syntax error further down.

findOpenaiCommand() {
	for candidate in $(type -a -p openai 2> /dev/null); do
		if "${candidate}" --version 2> /dev/null | grep -q '^openai version'; then
			echo "${candidate}"
			return 0
		fi
	done

	echo 'The official OpenAI command line program is not installed.' >&2
	echo 'Install it with: brew tap openai/tools && brew install openai/tools/openai' >&2
	return 1
}

requireJqCommand() {
	command -v jq > /dev/null 2>&1 && return 0

	echo 'The jq command line program is not installed. Install it with: brew install jq' >&2
	return 1
}
