#!/usr/bin/env bash
# Usage: tools/prepare.sh <song-id> <folder-with-cubase-mixdowns> [trim-seconds]
# Copies the 8 stems to audio/<song-id>/ with ASCII names and renders
# pitch-preserving slowed versions (90/80/70%) with ffmpeg atempo.
set -euo pipefail
ID="$1"; SRC="$2"; TRIM="${3:-}"
TRIM_ARGS=(); [ -n "$TRIM" ] && TRIM_ARGS=(-t "$TRIM")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/audio/$ID"
mkdir -p "$OUT"

# Oldest first, so if two exports map to the same track the newest one wins.
while IFS= read -r name; do
  f="$SRC/$name"
  dest=""
  case "$name" in
    *Soprano*) dest="S-vocal" ;;
    *Alto*)    dest="A-vocal" ;;
    *Tenor*)   dest="T-vocal" ;;
    *Bass*)    dest="B-vocal" ;;
    *-S-P.*) dest="S-piano" ;;
    *-A-P.*) dest="A-piano" ;;
    *-T-P.*) dest="T-piano" ;;
    *-B-P.*) dest="B-piano" ;;
  esac
  [ -z "$dest" ] && { echo "skip: $name"; continue; }
  echo "$name -> $dest"
  if [[ "$f" == *.mp3 && -z "$TRIM" ]]; then cp "$f" "$OUT/$dest.mp3"
  elif [[ "$f" == *.mp3 ]]; then ffmpeg -nostdin -loglevel error -y "${TRIM_ARGS[@]}" -i "$f" -c copy "$OUT/$dest.mp3"
  else ffmpeg -nostdin -loglevel error -y -i "$f" -c:a libmp3lame -b:a 192k "$OUT/$dest.mp3"; fi
  for pct in 90 80 70; do
    mkdir -p "$OUT/$pct"
    tempo=$(awk "BEGIN{print $pct/100}")
    ffmpeg -nostdin -loglevel error -y ${TRIM:+-t "$TRIM"} -i "$f" -filter:a "atempo=$tempo" -c:a libmp3lame -b:a 160k "$OUT/$pct/$dest.mp3"
  done
done < <(cd "$SRC" && ls -tr | grep -iE '\.(mp3|wav)$')
# Bump this song's version in songs.json so browsers fetch the new audio.
python3 - "$ROOT/songs.json" "$ID" "$(date +%Y%m%d%H%M%S)" <<'PY'
import json, sys
path, sid, ver = sys.argv[1:]
songs = json.load(open(path, encoding="utf-8"))
for s in songs:
    if s["id"] == sid: s["v"] = ver
with open(path, "w", encoding="utf-8") as f:
    f.write("[\n" + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in songs) + "\n]\n")
PY
echo "done: $OUT (songs.json version bumped)"
