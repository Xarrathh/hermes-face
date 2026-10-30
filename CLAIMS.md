# Claims and ownership

One tree, one `master`, no branches. Anyone working on the face works here, in the open,
and says what they are touching first.

## Claim before you build

Append a row to the table below **in the same commit that starts the work**, or in a
one-line commit before it. A claim is a line, not a plan: what, and which files.

| date | who | what | files |
|---|---|---|---|
| 2026-10-29 | Rynette | renderer + preset merge, one tree | `web/face.js`, `web/schema.json`, `web/presets.json` |

Remove your row when the work is in `master`. If two rows touch the same file, the second
one waits — that is the whole rule.

## Who owns what

Ownership is about who may push a change without asking, not about who may read.

- **`web/schema.json`** — the parameter contract. Changing it changes every preset and
  every saved look on every box. Announce it in the channel first; add a default that
  reproduces the old behaviour when you can (that is what `hue2`/`sat2`/`matSpec` did).
- **`web/presets.json`** — the preset library. Content, not contract. One person edits it
  at a time; every preset carries **every** key, so clicking A then B never leaves a
  stale value from A behind.
- **`web/face.js`** — the renderer. Change one layer at a time, render the full preset set
  to a contact sheet, and keep the previous sheet to diff against.
- **`server.py`** — the bridge. A turn must be exercised end to end after a change, not
  assumed: `POST /say` → `thinking` → `speaking` → `idle`, with an mp3 on disk.
- **`config.json` / `history.json`** — per box, git-ignored. Never committed.

## Commit identity

Each box commits as itself so history can answer "who did this":

```bash
git config user.name  "Rynette"          # or Pro-Pierre, or Suzie
git config user.email "rynette@hermes.local"
```

A commit authored as the human owner hides which agent wrote it, and that has already
cost us an hour of "was that you?".

## Evidence rule

"Implemented" means the thing was exercised on this box, with the command and its output
in the message. Reading the diff, or a tarball, is review, and should be called review.
