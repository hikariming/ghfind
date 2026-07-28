#!/usr/bin/env python3
"""Validate the identity and invariant layer of GHFind project artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCHEMA_VERSION = "ghfind.project-analysis.v2"
SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
DIMENSIONS = {
    "pain": 25,
    "effectiveness": 30,
    "experience": 30,
    "value_density": 15,
}
SCHEMA_DIRECTORY = Path(__file__).resolve().parent.parent / "schemas"
INTERNAL_PRODUCT_TAGS = {
    "micro-tool",
    "sdk-library",
    "web-app",
    "desktop-app",
    "framework-platform",
    "database-infra",
    "template-scaffold",
    "enterprise-system",
    "active-evolution",
    "stable-maintenance",
    "feature-complete",
    "experimental",
    "abandoned",
    "metadata-only",
    "source-inspected",
    "built",
    "core-flow-executed",
}
GENERIC_PRODUCT_TAG_LABELS = {
    "开源",
    "开源项目",
    "工具",
    "实用工具",
    "高质量",
    "open source",
    "open-source",
    "open-source project",
    "project",
    "tool",
    "useful tool",
    "high quality",
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def type_matches(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    return False


def validate_format(value: str, expected: str, path: str) -> None:
    if expected == "uri":
        parsed = urlparse(value)
        require(bool(parsed.scheme and parsed.netloc), f"{path} must be an absolute URI")
    elif expected == "date-time":
        try:
            dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"{path} must be an RFC 3339 date-time") from error


def validate_schema_value(value: Any, schema: dict[str, Any], path: str) -> None:
    alternatives = schema.get("anyOf")
    if isinstance(alternatives, list):
        for alternative in alternatives:
            try:
                validate_schema_value(value, alternative, path)
                return
            except ValueError:
                continue
        raise ValueError(f"{path} does not match any allowed schema")

    expected_type = schema.get("type")
    if isinstance(expected_type, str):
        require(type_matches(value, expected_type), f"{path} must be {expected_type}")
    if "const" in schema:
        require(value == schema["const"], f"{path} must equal {schema['const']!r}")
    if "enum" in schema:
        require(value in schema["enum"], f"{path} must be one of {schema['enum']!r}")

    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            require(name in value, f"{path}.{name} is required")
        if schema.get("additionalProperties") is False:
            extras = sorted(set(value) - set(properties))
            require(not extras, f"{path} has unsupported fields: {extras}")
        for name, child in properties.items():
            if name in value:
                validate_schema_value(value[name], child, f"{path}.{name}")

    if isinstance(value, list):
        if "minItems" in schema:
            require(len(value) >= schema["minItems"], f"{path} has too few items")
        if "maxItems" in schema:
            require(len(value) <= schema["maxItems"], f"{path} has too many items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_schema_value(item, item_schema, f"{path}[{index}]")

    if isinstance(value, str):
        if "minLength" in schema:
            require(len(value) >= schema["minLength"], f"{path} is too short")
        if "maxLength" in schema:
            require(len(value) <= schema["maxLength"], f"{path} is too long")
        if "pattern" in schema:
            require(re.search(schema["pattern"], value) is not None, f"{path} has invalid format")
        if isinstance(schema.get("format"), str):
            validate_format(value, schema["format"], path)

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema:
            require(value >= schema["minimum"], f"{path} is below the minimum")
        if "maximum" in schema:
            require(value <= schema["maximum"], f"{path} exceeds the maximum")


def validate_schema(value: dict[str, Any], schema_name: str, label: str) -> None:
    schema = read_json(SCHEMA_DIRECTORY / schema_name)
    validate_schema_value(value, schema, label)


def validate(analysis_path: Path, evidence_path: Path, report_path: Path) -> None:
    analysis = read_json(analysis_path)
    evidence = read_json(evidence_path)
    report = report_path.read_text(encoding="utf-8")

    validate_schema(analysis, "project-analysis.schema.json", "analysis")
    validate_schema(evidence, "runtime-evidence.schema.json", "evidence")

    require(analysis.get("schema_version") == SCHEMA_VERSION, "invalid analysis schema")
    require(evidence.get("schema_version") == SCHEMA_VERSION, "invalid evidence schema")
    require(analysis.get("analysis_id") == evidence.get("analysis_id"), "analysis id mismatch")

    repository = analysis.get("repository")
    require(isinstance(repository, dict), "repository must be an object")
    require(repository.get("repo_key") == evidence.get("repo_key"), "repo key mismatch")
    commit = repository.get("resolved_commit_sha")
    require(isinstance(commit, str) and SHA_PATTERN.fullmatch(commit) is not None, "invalid commit sha")
    require(commit == evidence.get("resolved_commit_sha"), "commit sha mismatch")

    entries = evidence.get("entries")
    require(isinstance(entries, list) and len(entries) > 0, "evidence entries are required")
    evidence_ids = {entry.get("id") for entry in entries if isinstance(entry, dict)}
    require(None not in evidence_ids and len(evidence_ids) == len(entries), "evidence ids must be unique")

    scores = analysis.get("scores")
    require(isinstance(scores, dict), "scores must be an object")
    total = 0
    referenced: set[str] = set()
    for name, maximum in DIMENSIONS.items():
        dimension = scores.get(name)
        require(isinstance(dimension, dict), f"missing score dimension {name}")
        score = dimension.get("score")
        require(isinstance(score, int) and 0 <= score <= maximum, f"invalid {name} score")
        require(dimension.get("max_score") == maximum, f"invalid {name} maximum")
        refs = dimension.get("evidence_ids")
        require(isinstance(refs, list) and len(refs) > 0, f"{name} requires evidence")
        referenced.update(str(item) for item in refs)
        total += score
    require(scores.get("product_score") == total, "product score must equal dimension sum")

    exposure = analysis.get("exposure")
    require(isinstance(exposure, dict), "exposure must be an object")
    community = analysis.get("community_strength")
    require(isinstance(community, dict), "community_strength must be an object")
    community_score = community.get("score")
    require(
        isinstance(community_score, (int, float)) and 0 <= community_score <= 100,
        "invalid community strength score",
    )
    referenced.update(str(item) for item in community.get("evidence_ids", []))
    referenced.update(str(item) for item in exposure.get("evidence_ids", []))

    project = analysis.get("project")
    require(isinstance(project, dict), "project must be an object")
    product_tags = project.get("product_tags")
    require(isinstance(product_tags, list) and 3 <= len(product_tags) <= 5, "project requires 3-5 product tags")
    slugs: set[str] = set()
    zh_labels: set[str] = set()
    en_labels: set[str] = set()
    for tag in product_tags:
        require(isinstance(tag, dict), "product tag must be an object")
        slug = tag.get("slug")
        require(isinstance(slug, str) and slug not in slugs, f"duplicate product tag slug: {slug}")
        require(slug not in INTERNAL_PRODUCT_TAGS, f"product tag exposes internal classification: {slug}")
        slugs.add(slug)
        labels = tag.get("labels")
        require(isinstance(labels, dict), f"product tag {slug} requires labels")
        for language, seen in (("zh", zh_labels), ("en", en_labels)):
            label = labels.get(language)
            require(isinstance(label, str), f"product tag {slug} requires {language} label")
            normalized = label.strip().lower()
            require(normalized not in seen, f"duplicate product tag label: {label}")
            require(normalized not in GENERIC_PRODUCT_TAG_LABELS, f"product tag is too generic: {label}")
            seen.add(normalized)
        tag_evidence = tag.get("evidence_ids")
        require(isinstance(tag_evidence, list) and tag_evidence, f"product tag {slug} requires evidence")
        referenced.update(str(item) for item in tag_evidence)

    for risk in analysis.get("risks", []):
        if isinstance(risk, dict):
            referenced.update(str(item) for item in risk.get("evidence_ids", []))
    missing = referenced - evidence_ids
    require(not missing, f"missing evidence ids: {sorted(missing)}")
    require(bool(report.strip()), "report must not be empty")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--analysis", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    validate(args.analysis, args.evidence, args.report)
    print("artifacts valid")


if __name__ == "__main__":
    main()
