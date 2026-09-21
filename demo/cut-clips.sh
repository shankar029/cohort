#!/usr/bin/env bash
# Cut 12 sub-clips from the full run, each timed to its voiceover line (+lead/tail).
# Strips audio (VO is separate). Optional 4th arg = source span in seconds: the clip is
# time-remapped (sped up / slowed down) to fill the scene duration. Keeps native res.
set -euo pipefail
SRC="C:/Users/shbs/Downloads/Cohort-Demo-1-1.mp4"
OUT="video/public/clips"
mkdir -p "$OUT"

cut() { # $1=id $2=start $3=dur $4=srcSpan(optional, default=dur)
  local id="$1" start="$2" dur="$3" span="${4:-$3}"
  local mult; mult=$(awk -v d="$dur" -v s="$span" 'BEGIN{printf "%.6f", d/s}')
  ffmpeg -y -loglevel error -ss "$start" -t "$span" -i "$SRC" -an \
    -vf "setpts=${mult}*PTS,scale=1920:-2" -r 30 \
    -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
    "$OUT/$id.mp4"
  printf "  %s  start=%ss dur=%ss span=%ss (x%.2f)\n" "$id" "$start" "$dur" "$span" "$(awk -v s="$span" -v d="$dur" 'BEGIN{print s/d}')"
}

cut scene01  76.0 14.55 21.0        # Agents: catalog -> roster -> model -> system prompt + Custom (CREATE TEAM) — sped
cut scene02 139.0  6.82 12.0        # chat: request typed (HOOK) — sped up (slow typing)
cut scene03 152.0  8.31 12.0        # chat: hit Send + Team Lead reads + plans epic (THE BRIEF)
cut scene04 165.0  9.95             # Team Lead plans parallel streams (TEAM ONLINE)
cut scene05 360.0 12.66             # Kanban board, cards across columns (DECOMPOSED)
cut scene06 195.3  8.69             # Team discussion: brainstorm + align (DISCUSSION)
cut scene07 500.0  7.62             # Threads: Code Reviewer float-bug evidence, blocks PR (REVIEW CATCH)
cut scene08 608.3  6.67  4.5        # Notifications: QA/security/coverage blocked (GATES) — slowed
cut scene09 613.0  8.45             # Board: "fix: unmet acceptance criteria" work item + detail (NEW WORK ITEMS)
cut scene10 548.0  6.28             # Git: PR Open + commit history (MERGE)
cut scene11 225.5  6.86             # Dashboard: metrics + active-now (COMMAND CENTER)
cut scene12 702.0  9.98             # Final dashboard 10/10 done (FINALE)
echo "done"
