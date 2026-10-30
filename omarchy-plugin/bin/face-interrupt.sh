#!/usr/bin/env bash
# Stop the live turn and its speech from the bar, without opening the face.
set -u
curl -s --max-time 3 -X POST -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:9120/interrupt >/dev/null
