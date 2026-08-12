"""Preprocess ICPH meta-form DOCX files into Markdown and RAG chunks.

The script is intentionally rerun-safe:
- DOCX files under SchemaTerminologies/schemas/ICPH_MetaForms/originalDocx
  are converted only when new or changed, unless --force is passed.
- Markdown, per-document chunks, an aggregate chunk file, and a manifest are
  written under SchemaTerminologies/schemas/ICPH_MetaForms/processedMD.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_META_FORMS_ROOT = PROJECT_ROOT / "SchemaTerminologies" / "schemas" / "ICPH_MetaForms"
DEFAULT_INPUT_DIR = DEFAULT_META_FORMS_ROOT / "originalDocx"
DEFAULT_OUTPUT_DIR = DEFAULT_META_FORMS_ROOT / "processedMD"
MANIFEST_NAME = "icph_metaforms_manifest.json"
AGGREGATE_CHUNKS_NAME = "icph_metaform_chunks.jsonl"


@dataclass(frozen=True)
class SchemaRow:
    document_name: str
    document_sha256: str
    form_title: str
    form_index: int
    variable: str
    question: str
    format_options: str
    instructions: str
    row_index: int

    def text(self) -> str:
        parts = [
            f"Document: {self.document_name}",
            f"Form: {self.form_title}",
            f"Variable: {self.variable}",
            f"Question: {self.question}",
            f"Format/options: {self.format_options}",
            f"Instructions: {self.instructions}",
        ]
        return "\n".join(part for part in parts if not part.endswith(": "))


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for block in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_stem(path: Path) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", path.stem).strip("_") or "document"


def clean_markdown_cell(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\*\*(.*?)\*\*", r"\1", value)
    value = re.sub(r"\*(.*?)\*", r"\1", value)
    value = value.replace("\\|", "|")
    return re.sub(r"\s+", " ", value).strip()


def clean_markdown_text(value: str) -> str:
    value = clean_markdown_cell(value)
    value = value.replace("\\*", "*").replace("\\_", "_")
    value = re.sub(r"[_]{3,}", " ", value)
    value = value.replace("☐", " ")
    return re.sub(r"\s+", " ", value).strip(" -*\\")


def variable_name_from_label(label: str, fallback: str) -> str:
    text = clean_markdown_text(label).lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    text = re.sub(r"_+", "_", text)
    if not text:
        return fallback
    if re.match(r"^\d", text):
        text = f"q_{text}"
    return text[:64]


def split_markdown_row(line: str) -> list[str]:
    line = line.strip()
    if not line.startswith("|"):
        return []
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in line.strip("|"):
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == "\\":
            current.append(char)
            escaped = True
            continue
        if char == "|":
            cells.append(clean_markdown_cell("".join(current)))
            current = []
        else:
            current.append(char)
    cells.append(clean_markdown_cell("".join(current)))
    return cells


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells if cell.strip())


def iter_markdown_tables(markdown_text: str) -> Iterable[list[list[str]]]:
    table: list[list[str]] = []
    for line in markdown_text.splitlines():
        cells = split_markdown_row(line)
        if cells:
            table.append(cells)
            continue
        if table:
            yield table
            table = []
    if table:
        yield table


def normalize_cells(cells: list[str], width: int = 4) -> list[str]:
    padded = cells[:width] + [""] * max(0, width - len(cells))
    return padded[:width]


def is_variable_code(value: str) -> bool:
    if not value:
        return False
    return bool(re.fullmatch(r"[A-Za-z]{0,4}\d+[A-Za-z0-9]*", value.strip()))


def form_title_from_table(table: list[list[str]]) -> str | None:
    for cells in table:
        normalized = normalize_cells(cells)
        for cell in normalized:
            cleaned = clean_markdown_cell(cell)
            if re.match(r"^Form\s+\d+\.", cleaned, flags=re.IGNORECASE):
                return cleaned
    return None


def extract_schema_rows(markdown_text: str, document_name: str, document_sha256: str) -> list[SchemaRow]:
    rows: list[SchemaRow] = []
    form_index = 0
    for table in iter_markdown_tables(markdown_text):
        title = form_title_from_table(table)
        if not title:
            continue
        form_index += 1
        for row_index, cells in enumerate(table, start=1):
            if is_separator_row(cells):
                continue
            variable, question, format_options, instructions = normalize_cells(cells)
            if not is_variable_code(variable):
                continue
            rows.append(
                SchemaRow(
                    document_name=document_name,
                    document_sha256=document_sha256,
                    form_title=title,
                    form_index=form_index,
                    variable=variable,
                    question=question,
                    format_options=format_options,
                    instructions=instructions,
                    row_index=row_index,
                )
            )
    if rows:
        return rows
    return extract_interview_rows(markdown_text, document_name, document_sha256)


def markdown_heading_text(line: str) -> str:
    match = re.fullmatch(r"\*\*(.+?)\*\*", line.strip())
    return clean_markdown_text(match.group(1)) if match else ""


def extract_document_title(lines: list[str], document_name: str) -> str:
    for line in lines:
        heading = markdown_heading_text(line)
        if heading:
            return heading
    return Path(document_name).stem.replace("_", " ")


def is_section_heading(text: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]\s+.+", text)) and not re.match(r"^[A-Z]\d+\.", text)


def option_text_from_line(line: str) -> str:
    if "☐" not in line:
        return ""
    parts = [clean_markdown_text(part) for part in line.split("☐")]
    return "; ".join(part for part in parts if part)


def append_interview_row(
    rows: list[SchemaRow],
    *,
    document_name: str,
    document_sha256: str,
    form_title: str,
    variable: str,
    question: str,
    format_options: str = "",
    instructions: str = "",
) -> None:
    if not variable or not question:
        return
    rows.append(
        SchemaRow(
            document_name=document_name,
            document_sha256=document_sha256,
            form_title=form_title,
            form_index=1,
            variable=variable,
            question=question,
            format_options=format_options,
            instructions=instructions,
            row_index=len(rows) + 1,
        )
    )


def extract_identification_rows(table: list[list[str]], *, document_name: str, document_sha256: str, form_title: str) -> list[SchemaRow]:
    rows: list[SchemaRow] = []
    seen: set[str] = set()
    for cells in table:
        for cell in cells:
            for match in re.finditer(r"\*\*(.+?)\*\*", cell):
                label = clean_markdown_text(match.group(1))
                if not label or len(label) > 90:
                    continue
                variable = variable_name_from_label(label, f"id_{len(rows) + 1}")
                if variable in seen:
                    continue
                seen.add(variable)
                append_interview_row(
                    rows,
                    document_name=document_name,
                    document_sha256=document_sha256,
                    form_title=form_title,
                    variable=variable,
                    question=label,
                    format_options="free text/date field" if "date" in label.lower() else "free text",
                )
    return rows


def extract_inline_label_rows(lines: list[str], *, document_name: str, document_sha256: str, form_title: str) -> list[SchemaRow]:
    rows: list[SchemaRow] = []
    seen: set[str] = set()
    for line in lines:
        if "___" not in line and "\\_" not in line:
            continue
        for match in re.finditer(r"\*\*(.+?)\*\*", line):
            label = clean_markdown_text(match.group(1))
            if not label or re.match(r"^[A-Z]\d+[A-Za-z]?\.", label) or is_section_heading(label):
                continue
            variable = variable_name_from_label(label, f"field_{len(rows) + 1}")
            if variable in seen:
                continue
            seen.add(variable)
            append_interview_row(
                rows,
                document_name=document_name,
                document_sha256=document_sha256,
                form_title=form_title,
                variable=variable,
                question=label,
                format_options="free text/date field" if "date" in label.lower() else "free text",
            )
    return rows


def extract_interview_rows(markdown_text: str, document_name: str, document_sha256: str) -> list[SchemaRow]:
    lines = [line.strip() for line in markdown_text.splitlines() if line.strip()]
    form_title = extract_document_title(lines, document_name)
    rows: list[SchemaRow] = extract_inline_label_rows(
        lines,
        document_name=document_name,
        document_sha256=document_sha256,
        form_title=form_title,
    )

    for table in iter_markdown_tables(markdown_text):
        if any("Participant ID" in cell for row in table for cell in row):
            rows.extend(extract_identification_rows(table, document_name=document_name, document_sha256=document_sha256, form_title=form_title))

    current: dict[str, object] | None = None
    section = ""

    def flush_current() -> None:
        nonlocal current
        if not current:
            return
        append_interview_row(
            rows,
            document_name=document_name,
            document_sha256=document_sha256,
            form_title=form_title,
            variable=str(current["variable"]),
            question=str(current["question"]),
            format_options="; ".join(current["options"]) if current["options"] else str(current["format_options"]),
            instructions=" ".join(current["instructions"]),
        )
        current = None

    for line in lines:
        heading = markdown_heading_text(line)
        if heading and is_section_heading(heading):
            flush_current()
            section = heading
            continue

        question_match = re.match(r"\*\*([A-Z]\d+[A-Za-z]?)\.\s*(.+)\*\*", line)
        if question_match:
            flush_current()
            variable = question_match.group(1)
            question = clean_markdown_text(question_match.group(2))
            current = {
                "variable": variable,
                "question": question,
                "options": [],
                "format_options": "",
                "instructions": [section] if section else [],
            }
            continue

        if not current:
            continue

        options = option_text_from_line(line)
        if options:
            current["options"].append(options)
            continue

        cleaned = clean_markdown_text(line)
        if not cleaned:
            if not current["format_options"]:
                current["format_options"] = "free text"
            continue
        if cleaned.startswith("*") or cleaned.startswith("|"):
            continue
        if re.search(r"Hours:|minutes|describe|details|notes|approximately|If ", cleaned, flags=re.IGNORECASE):
            current["instructions"].append(cleaned)

    flush_current()
    return rows


def rows_to_chunks(rows: list[SchemaRow]) -> list[dict]:
    chunks: list[dict] = []
    forms: dict[tuple[int, str], list[SchemaRow]] = {}
    for row in rows:
        forms.setdefault((row.form_index, row.form_title), []).append(row)

    for (form_index, form_title), form_rows in forms.items():
        document_name = form_rows[0].document_name
        document_sha256 = form_rows[0].document_sha256
        variable_codes = [row.variable for row in form_rows]
        form_text = "\n\n".join(row.text() for row in form_rows)
        chunks.append(
            {
                "chunk_id": f"{safe_stem(Path(document_name))}::form::{form_index}",
                "chunk_type": "form",
                "document_name": document_name,
                "document_sha256": document_sha256,
                "form_title": form_title,
                "form_index": form_index,
                "variables": variable_codes,
                "text": form_text,
            }
        )
        for row in form_rows:
            payload = asdict(row)
            payload.update(
                {
                    "chunk_id": f"{safe_stem(Path(document_name))}::form::{form_index}::var::{row.variable}",
                    "chunk_type": "variable",
                    "variables": [row.variable],
                    "text": row.text(),
                }
            )
            chunks.append(payload)
    return chunks


def write_jsonl(path: Path, records: Iterable[dict]) -> int:
    count = 0
    with path.open("w", encoding="utf-8") as file_handle:
        for record in records:
            file_handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            count += 1
    return count


def read_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    if not path.is_file():
        return records
    with path.open("r", encoding="utf-8") as file_handle:
        for line in file_handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        return {"processed_at": None, "documents": {}}
    with path.open("r", encoding="utf-8") as file_handle:
        return json.load(file_handle)


def save_manifest(path: Path, manifest: dict) -> None:
    manifest["processed_at"] = now_utc()
    with path.open("w", encoding="utf-8") as file_handle:
        json.dump(manifest, file_handle, indent=2, ensure_ascii=False, sort_keys=True)
        file_handle.write("\n")


def process_docx(docx_path: Path, output_dir: Path, *, force: bool, manifest: dict) -> tuple[str, dict]:
    try:
        from markitdown import MarkItDown
    except ImportError as exc:  # pragma: no cover - gives a useful CLI failure.
        raise SystemExit(
            "markitdown is not installed. Run: "
            "python -m pip install 'markitdown[docx]'"
        ) from exc

    digest = sha256_file(docx_path)
    stem = safe_stem(docx_path)
    markdown_path = output_dir / f"{stem}.md"
    chunks_path = output_dir / f"{stem}.chunks.jsonl"
    previous = manifest.get("documents", {}).get(docx_path.name, {})

    if (
        not force
        and previous.get("sha256") == digest
        and markdown_path.is_file()
        and chunks_path.is_file()
    ):
        chunks = read_jsonl(chunks_path)
        return "skipped", {
            **previous,
            "markdown_path": str(markdown_path.relative_to(PROJECT_ROOT)),
            "chunks_path": str(chunks_path.relative_to(PROJECT_ROOT)),
            "chunk_count": len(chunks),
        }

    converted = MarkItDown(enable_plugins=False).convert(str(docx_path))
    markdown_text = converted.text_content
    markdown_path.write_text(markdown_text, encoding="utf-8")

    schema_rows = extract_schema_rows(markdown_text, docx_path.name, digest)
    chunks = rows_to_chunks(schema_rows)
    chunk_count = write_jsonl(chunks_path, chunks)

    return "processed", {
        "sha256": digest,
        "source_path": str(docx_path.relative_to(PROJECT_ROOT)),
        "markdown_path": str(markdown_path.relative_to(PROJECT_ROOT)),
        "chunks_path": str(chunks_path.relative_to(PROJECT_ROOT)),
        "source_size_bytes": docx_path.stat().st_size,
        "processed_at": now_utc(),
        "form_count": len({(row.form_index, row.form_title) for row in schema_rows}),
        "variable_count": len(schema_rows),
        "chunk_count": chunk_count,
    }


def rebuild_aggregate_chunks(output_dir: Path, manifest: dict) -> int:
    records: list[dict] = []
    for info in sorted(manifest.get("documents", {}).values(), key=lambda item: item.get("source_path", "")):
        chunks_path = PROJECT_ROOT / info["chunks_path"]
        records.extend(read_jsonl(chunks_path))
    return write_jsonl(output_dir / AGGREGATE_CHUNKS_NAME, records)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--force", action="store_true", help="Reprocess files even if their hash is unchanged.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    input_dir = args.input_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {input_dir}")

    manifest_path = output_dir / MANIFEST_NAME
    manifest = load_manifest(manifest_path)
    manifest.setdefault("documents", {})

    docx_files = sorted(path for path in input_dir.glob("*.docx") if not path.name.startswith("~$"))
    if not docx_files:
        print(f"No DOCX files found under {input_dir}")
        return 0

    processed = 0
    skipped = 0
    for docx_path in docx_files:
        status, info = process_docx(docx_path, output_dir, force=args.force, manifest=manifest)
        manifest["documents"][docx_path.name] = info
        if status == "processed":
            processed += 1
        else:
            skipped += 1
        print(
            f"{status}: {docx_path.name} "
            f"forms={info.get('form_count', 'n/a')} "
            f"variables={info.get('variable_count', 'n/a')} "
            f"chunks={info.get('chunk_count', 'n/a')}"
        )

    aggregate_count = rebuild_aggregate_chunks(output_dir, manifest)
    manifest["aggregate_chunks_path"] = str((output_dir / AGGREGATE_CHUNKS_NAME).relative_to(PROJECT_ROOT))
    manifest["aggregate_chunk_count"] = aggregate_count
    save_manifest(manifest_path, manifest)

    print(f"done: processed={processed} skipped={skipped} aggregate_chunks={aggregate_count}")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
