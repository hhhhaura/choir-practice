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

shopt -s nullglob
for f in "$SRC"/*.mp3 "$SRC"/*.wav; do
  name="$(basename "$f")"
  dest=""
  case "$name" in
    *-S-P.*) dest="S-piano" ;;
    *-A-P.*) dest="A-piano" ;;
    *-T-P.*) dest="T-piano" ;;
    *-B-P.*) dest="B-piano" ;;
    *Soprano*) dest="S-vocal" ;;
    *Alto*)    dest="A-vocal" ;;
    *Tenor*)   dest="T-vocal" ;;
    *Bass*)    dest="B-vocal" ;;
  esac
  [ -z "$dest" ] && { echo "skip: $name"; continue; }
  echo "$name -> $dest"
  if [[ "$f" == *.mp3 && -z "$TRIM" ]]; then cp "$f" "$OUT/$dest.mp3"
  elif [[ "$f" == *.mp3 ]]; then ffmpeg -loglevel error -y "${TRIM_ARGS[@]}" -i "$f" -c copy "$OUT/$dest.mp3"
  else ffmpeg -loglevel error -y -i "$f" -c:a libmp3lame -b:a 192k "$OUT/$dest.mp3"; fi
  for pct in 90 80 70; do
    mkdir -p "$OUT/$pct"
    tempo=$(awk "BEGIN{print $pct/100}")
    ffmpeg -loglevel error -y ${TRIM:+-t "$TRIM"} -i "$f" -filter:a "atempo=$tempo" -c:a libmp3lame -b:a 160k "$OUT/$pct/$dest.mp3"
  done
done
echo "done: $OUT"
