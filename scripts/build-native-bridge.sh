#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
bridge_dir="$project_dir/native/MeetingCaptureBridge"
output_dir="$project_dir/src-tauri/resources"
pdf_bridge_source="$project_dir/native/PdfTextBridge/main.swift"

mkdir -p "$output_dir"
capture_output="$output_dir/MeetingCaptureBridge"
pdf_output="$output_dir/PdfTextBridge"

if [[ ! -x "$capture_output" ]] \
  || [[ "$bridge_dir/Package.swift" -nt "$capture_output" ]] \
  || find "$bridge_dir/Sources" -type f -newer "$capture_output" -print -quit | grep -q .; then
  swift build --package-path "$bridge_dir" -c release
  cp "$bridge_dir/.build/release/MeetingCaptureBridge" "$capture_output"
  chmod +x "$capture_output"
fi

if [[ ! -x "$pdf_output" ]] || [[ "$pdf_bridge_source" -nt "$pdf_output" ]]; then
  xcrun swiftc -O -framework PDFKit "$pdf_bridge_source" -o "$pdf_output"
  chmod +x "$pdf_output"
fi

echo "Built native bridges in $output_dir"
