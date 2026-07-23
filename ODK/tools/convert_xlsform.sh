#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 path/to/form.xlsx [path/to/output.xml]" >&2
  exit 2
fi

input_path="$1"

if [[ ! -f "$input_path" ]]; then
  echo "Input XLSForm not found: $input_path" >&2
  exit 1
fi

if ! command -v xls2xform >/dev/null 2>&1; then
  echo "xls2xform is not installed in this shell." >&2
  echo "Activate the venv and install tools first:" >&2
  echo "  source .venv-xlsform/bin/activate" >&2
  echo "  pip install -r tools/requirements-xlsform.txt" >&2
  exit 1
fi

if [[ $# -eq 2 ]]; then
  output_path="$2"
else
  mkdir -p forms/converted
  base_name="$(basename "$input_path")"
  output_path="forms/converted/${base_name%.*}.xml"
fi

mkdir -p "$(dirname "$output_path")"
xls2xform "$input_path" "$output_path"

echo "Converted XLSForm:"
echo "  input:  $input_path"
echo "  output: $output_path"
