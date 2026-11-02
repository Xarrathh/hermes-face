#!/usr/bin/env bash
# Open the Hermes face menu from the bar glyph.
#
# This exists as a script rather than an inline command because the bar's run() hands its argument
# to the shell as a single program name — "omarchy menu summon hermes" sent that way silently does
# nothing, which is exactly how right click came to look broken.
set -u
# toggle, not summon: a second right click should close the menu the way every other bar menu does
exec omarchy menu toggle hermes
