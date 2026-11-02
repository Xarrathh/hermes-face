#!/usr/bin/env bash
# Open the Hermes face menu from the bar glyph.
#
# This exists as a script rather than an inline command because the bar's run() hands its argument
# to the shell as a single program name — "omarchy menu summon hermes" sent that way silently does
# nothing, which is exactly how right click came to look broken.
set -u
# summon, not toggle: a click that seemed to do nothing usually closed a menu that was already
# open, and the one thing this must never do is leave him with no menu at all.
exec omarchy menu summon hermes
