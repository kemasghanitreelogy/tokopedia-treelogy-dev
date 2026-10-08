#!/usr/bin/env bash
# Hapus laporan run QA yang lebih tua dari 1 hari (permintaan 8 Okt 2026: disk 38 GB
# penuh oleh laporan QA - video, trace dan screenshot 1,5-5 GB per run).
#
# Hanya folder run bernama waktu (2026-10-08T15-00); state.json, history.json dan
# baseline (read-baseline-*) tidak pernah disentuh. Run terbaru selalu disimpan, walau
# lebih tua dari sehari - kalau QA berhenti, laporan terakhirnya tetap ada untuk dibaca.
set -euo pipefail
ROOT="${QA_ROOT:-/opt/treelogy-qa}"
KEEP_MINUTES="${QA_KEEP_MINUTES:-1440}"
for dir in "$ROOT/reports" "$ROOT/reports-dev"; do
  [ -d "$dir" ] || continue
  newest="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}' -printf '%f\n' | sort | tail -1)"
  find "$dir" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}' -mmin +"$KEEP_MINUTES" -printf '%f\n' |
  while read -r run; do
    [ "$run" = "$newest" ] && continue
    rm -rf -- "${dir:?}/$run"
    echo "dihapus: $dir/$run"
  done
done
df -h / | tail -1
