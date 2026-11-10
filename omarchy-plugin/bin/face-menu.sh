#!/usr/bin/env bash
# Open the Hermes face menu from the bar glyph.
#
# A script rather than an inline command: the menu route must be summonable from a terminal
# and from a keybinding as well as from a click, and a wrapper is the only form all three can
# share. (`bar.run()` does hand its string to a shell, but the click handler itself is the
# fragile part, so keep the action testable without a mouse.)
set -u
# summon, not toggle: a click that seemed to do nothing usually closed a menu that was already
# open, and the one thing this must never do is leave him with no menu at all.
exec omarchy menu summon hermes
