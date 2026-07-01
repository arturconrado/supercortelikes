#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def percentage(covered: int, total: int) -> float:
    return 100.0 if total == 0 else covered * 100.0 / total


def main() -> int:
    if len(sys.argv) not in {2, 3}:
        raise SystemExit("usage: check_coverage.py COVERAGE_JSON [MINIMUM]")
    report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    minimum = float(sys.argv[2]) if len(sys.argv) == 3 else 60.0
    totals = report["totals"]

    functions = [
        function
        for file_data in report["files"].values()
        for name, function in file_data.get("functions", {}).items()
        if name
    ]
    metrics = {
        "statements": percentage(totals["covered_lines"], totals["num_statements"]),
        "lines": percentage(totals["covered_lines"], totals["num_statements"]),
        "branches": percentage(totals["covered_branches"], totals["num_branches"]),
        "functions": percentage(
            sum(bool(function["executed_lines"]) for function in functions),
            len(functions),
        ),
    }
    print(json.dumps({name: round(value, 2) for name, value in metrics.items()}, sort_keys=True))
    failed = {name: value for name, value in metrics.items() if value < minimum}
    if failed:
        print(
            "coverage gate failed: "
            + ", ".join(f"{name}={value:.2f}%" for name, value in failed.items()),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
