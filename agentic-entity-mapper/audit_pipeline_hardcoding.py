"""Fail when active agents contain entity-specific clinical hardcoding.

This check intentionally excludes presentation modules. Protocol contracts such
as FHIR field names, terminology columns, lifecycle values, and code-system URLs
are not clinical hardcoding and remain valid in the pipeline.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
PIPELINE_FILES = (
    "abbreviation_agent.py",
    "cache.py",
    "fhir_bundle_agent.py",
    "icd10_mapper_agent.py",
    "llm_runtime.py",
    "loinc_mapper_agent.py",
    "medspacy_context_agent.py",
    "pipeline_resilience.py",
    "rxnorm_mapper_agent.py",
    "schema_terminology_assets.py",
    "snomed_mapper_agent.py",
    "terminology_dense_search.py",
)
PROMPT_FILES = tuple(
    sorted(path.relative_to(PROJECT_ROOT).as_posix() for path in (PROJECT_ROOT / "prompts").glob("*.txt"))
)

PROHIBITED_TABLE_NAME = re.compile(
    r"(?:entity|clinical|phrase|keyword|trigger|synonym|spelling|term|concept)"
    r".*(?:override|map|mapping|rules?|dictionary|corrections?)$",
    re.IGNORECASE,
)
PROHIBITED_TEMPLATE_NAME = re.compile(
    r"(?:clinical|fhir|resource).*(?:skeleton|template)$",
    re.IGNORECASE,
)
ENTITY_VARIABLE_NAME = re.compile(
    r"^(?:entity|entity_text|clinical_entity|term|query_term)$",
    re.IGNORECASE,
)
SNOMED_LIKE_CODE = re.compile(r"\d{6,18}")
ICD10_LIKE_CODE = re.compile(r"[A-TV-Z][0-9][0-9AB](?:\.[0-9A-TV-Z]{1,4})?", re.IGNORECASE)


def _assigned_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        return [name for item in node.elts for name in _assigned_names(item)]
    return []


def _literal_string(node: ast.AST) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip()
    return ""


def _looks_like_ontology_code(value: str) -> bool:
    return bool(SNOMED_LIKE_CODE.fullmatch(value) or ICD10_LIKE_CODE.fullmatch(value))


def _is_collection(node: ast.AST | None) -> bool:
    return isinstance(node, (ast.Dict, ast.List, ast.Tuple, ast.Set))


def _entity_literal_comparison(node: ast.Compare) -> str:
    operands = [node.left, *node.comparators]
    variable_names = {
        operand.id
        for operand in operands
        if isinstance(operand, ast.Name) and ENTITY_VARIABLE_NAME.fullmatch(operand.id)
    }
    literals = [_literal_string(operand) for operand in operands]
    clinical_literals = [
        value
        for value in literals
        if value
        and re.search(r"[a-z]", value, re.IGNORECASE)
        and not value.startswith(("http://", "https://", "urn:"))
    ]
    if variable_names and clinical_literals:
        return (
            "entity-specific comparison "
            f"({', '.join(sorted(variable_names))} against {clinical_literals!r})"
        )
    return ""


def audit_file(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    issues: list[str] = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = node.value
            for target in targets:
                for name in _assigned_names(target):
                    if PROHIBITED_TABLE_NAME.search(name) and _is_collection(value):
                        issues.append(
                            f"{path.name}:{node.lineno}: prohibited clinical rule table {name!r}"
                        )
                    if PROHIBITED_TEMPLATE_NAME.search(name):
                        issues.append(
                            f"{path.name}:{node.lineno}: prohibited fixed pipeline template {name!r}"
                        )

        if isinstance(node, ast.Dict):
            for key_node, value_node in zip(node.keys, node.values):
                key = _literal_string(key_node) if key_node is not None else ""
                value = _literal_string(value_node)
                if key and value and _looks_like_ontology_code(value):
                    issues.append(
                        f"{path.name}:{node.lineno}: literal term-to-code entry {key!r} -> {value!r}"
                    )

        if isinstance(node, ast.Compare):
            comparison_issue = _entity_literal_comparison(node)
            if comparison_issue:
                issues.append(f"{path.name}:{node.lineno}: {comparison_issue}")

            for operand in [node.left, *node.comparators]:
                value = _literal_string(operand)
                if value and _looks_like_ontology_code(value):
                    issues.append(
                        f"{path.name}:{node.lineno}: branch compares against ontology code {value!r}"
                    )

    return issues


def audit_prompt(path: Path) -> list[str]:
    """Reject ontology codes and explicit term-to-code rules in active prompts."""
    text = path.read_text(encoding="utf-8")
    issues = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        code_tokens = re.findall(r"(?<![A-Za-z0-9])\d{6,18}(?![A-Za-z0-9])", line)
        code_tokens.extend(
            re.findall(
                r"(?<![A-Za-z0-9])[A-TV-Z][0-9][0-9AB](?:\.[0-9A-TV-Z]{1,4})?(?![A-Za-z0-9])",
                line,
                re.IGNORECASE,
            )
        )
        if code_tokens:
            issues.append(
                f"{path.relative_to(PROJECT_ROOT)}:{line_number}: fixed ontology code(s) {code_tokens!r}"
            )
    return issues


def main() -> int:
    checked_files = (*PIPELINE_FILES, *PROMPT_FILES)
    missing = [name for name in checked_files if not (PROJECT_ROOT / name).is_file()]
    issues = [
        issue
        for filename in PIPELINE_FILES
        for issue in audit_file(PROJECT_ROOT / filename)
        if filename not in missing
    ]
    issues.extend(
        issue
        for filename in PROMPT_FILES
        for issue in audit_prompt(PROJECT_ROOT / filename)
        if filename not in missing
    )

    if missing:
        issues.extend(f"missing pipeline file: {filename}" for filename in missing)

    if issues:
        print("Clinical hardcoding policy violations:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print(
        f"PASS: {len(PIPELINE_FILES)} active pipeline modules and "
        f"{len(PROMPT_FILES)} active prompts contain no prohibited clinical hardcoding."
    )
    print("Presentation-only modules are intentionally outside this policy check.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
