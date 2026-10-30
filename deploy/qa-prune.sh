#!/usr/bin/env bash
# Hapus laporan run QA yang lebih tua dari 12 jam (permintaan 8 Okt 2026: disk 38 GB
# penuh oleh laporan QA - video, trace dan screenshot 1,5-5 GB per run).
#
# 12 jam, bukan sehari (30 Okt 2026): QA jalan 03:00 dan 16:00 WITA, jadi dengan batas
# sehari run kemarin pagi masih ada saat run pagi ini menulis - tiga run sekaligus
# (~10 GB) mendorong disk lewat 80% tiap pagi. Dengan 12 jam paling banyak dua.
#
# Hanya folder run bernama waktu (2026-10-08T15-00); state.json, history.json dan
# baseline (read-baseline-*) tidak pernah disentuh. Run terbaru selalu disimpan, walau
# lebih tua dari 12 jam - kalau QA berhenti, laporan terakhirnya tetap ada untuk dibaca.
set -euo pipefail
ROOT="${QA_ROOT:-/opt/treelogy-qa}"
KEEP_MINUTES="${QA_KEEP_MINUTES:-720}"
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
