#!/usr/bin/env bash
# Sustained rsync-pull loop emulating the importer pulling a finalised run FROM
# this host (the robot role): sshd serves the disk read + encrypt; the rsync
# client decrypts + writes. Over loopback both ends land on this host — a
# deliberate pessimistic double-count of the ssh crypto CPU. Point EVAL_SSH at
# a second host to make the NIC leg real.
#   $1 = bwlimit KB/s (0 = unlimited), $2 = log file.
# Deletes the dest each pass so every pull is a full re-copy.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-/tmp/kairos_overlap_eval}"
SRC="${EVAL_SRC:-$REPO_ROOT/data/airoa-moma-mcap/064423}"
PEER="${EVAL_SSH:-$USER@127.0.0.1}"
KEY="${EVAL_SSH_KEY:?set EVAL_SSH_KEY to an identity authorized on $PEER}"
DEST="$OUT_DIR/rsync_dest"
SRC_MB=$(du -sm "$SRC" | cut -f1)

OPTS=(-a --partial -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$OUT_DIR/known_hosts -o IdentitiesOnly=yes -o BatchMode=yes")
[ "$1" != "0" ] && OPTS+=(--bwlimit="$1")

pass=0
while :; do
  rm -rf "$DEST"; mkdir -p "$DEST"
  S=$(date +%s.%N)
  rsync "${OPTS[@]}" "$PEER:$SRC/" "$DEST/" >>"$2" 2>&1
  E=$(date +%s.%N)
  pass=$((pass + 1))
  echo "PASS $pass size_mb=$SRC_MB elapsed=$(awk -v a="$E" -v b="$S" 'BEGIN{printf "%.1f", a-b}')s" >> "$2"
done
