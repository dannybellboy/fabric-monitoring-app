"""One-time import of the HDX Deployment Tracker spreadsheet into deploy.DeploymentTracker.

Reads the PI27.2 and PI27.3 sheets of "HDX Deployment Tracker.xlsx" and inserts a
row per component. The third sheet, "Bronze Table Ingestion Tracker", is a
different shape entirely (a PG/MIRROR/FABRIC status per environment) and is not
imported -- it needs its own table.

Idempotent: rows already present (matched on PI + wave + item + component) are
skipped, so a re-run only picks up what was added to the sheet since last time.

## What the sheet cannot tell us

The spreadsheet records each gate as Y/N, never a date. So every gate imports as
"passed, day unknown": the flag is set and the companion `<Gate>Date` is left
NULL. Nothing is backdated and nothing is invented. Gates ticked in the app from
now on record both.

`QA Approved` also carries `B` (blocked) and `IP` (in progress) on a handful of
rows. Neither means approved, so the flag is left off and the raw value is
preserved in Notes rather than silently discarded.

Usage:
    python import_tracker.py "C:\\path\\HDX Deployment Tracker.xlsx"
    python import_tracker.py "C:\\path\\HDX Deployment Tracker.xlsx" --apply
"""
from __future__ import annotations

import argparse
import sys
import uuid
from datetime import date, datetime, timezone

import deployments
from fabric_auth import get_identity
from warehouse import execute, ping, query

# Sheets to import, and the spreadsheet header each column comes from. The sheets
# disagree on column order and PI27.2 has no Priority column at all, so mapping is
# by header text, never by position.
SHEETS = ("PI27.2", "PI27.3")

# spreadsheet header -> table column
DETAIL_MAP = {
    "Release": "ReleaseWave",
    "Release Date": "ReleaseDate",
    "Item": "Item",
    "Priority": "Priority",
    "Component Name": "ComponentName",
    "Component Type": "ComponentType",
    "Data Modeling": "DataModeling",
    "Developer": "Developer",
    "QA Approval": "QAApproval",
    "UAT Approver": "UATApprover",
    "Notes": "Notes",
}

# spreadsheet header -> gate flag column, in gate order.
GATE_MAP = {
    "Data Modeling Complete": "DataModelingComplete",
    "Ready for Code Review": "ReadyForCodeReview",
    "Code Review Approved": "CodeReviewApproved",
    "Deployed to QA": "DeployedToQA",
    "QA Approved": "QAApproved",
    "Deployed to UAT": "DeployedToUAT",
    "UAT Approved": "UATApproved",
    "UAT Smoke Tests Approved": "UATSmokeTestsApproved",
    "Ready for Prod Deployment": "ReadyForProdDeployment",
    "Deployed to Prod": "DeployedToProd",
    "Prod Smoke Tests Passed": "ProdSmokeTestsPassed",
}

PRIORITY_MAP = {"h": "High", "m": "Medium", "l": "Low"}

# Values that mean "passed". Everything else -- N, B, IP, blank -- does not.
_PASSED = {"y", "yes", "x", "complete", "done", "true", "1"}
# Values that are not a pass but do say something, so they are kept in Notes.
_NOT_A_FLAG = {"b", "ip"}

# Rows per INSERT. Fabric Warehouse writes a parquet file per statement, so
# single-row inserts would leave hundreds of tiny files behind and take minutes.
# 50 rows x 39 parameters = 1950, safely under the 2100-parameter limit.
BATCH_SIZE = 50

_INSERT_COLUMNS = (
    ("DeploymentId",)
    + tuple(deployments.EDITABLE_FIELDS)
    + ("CreatedBy", "CreatedDate", "LastModified", "LastModifiedBy")
)


def pi_label(sheet: str) -> str:
    """'PI27.2' -> 'PI 27.2', so the picker reads like people say it."""
    name = sheet.strip()
    if name.upper().startswith("PI") and not name[2:3].isspace():
        return f"PI {name[2:].strip()}"
    return name


def _text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    text = str(value).strip()
    return text or None


def _as_date(value) -> date | None:
    """Real dates pass through; text is parsed where it can be.

    PI27.2's Release Date column mixes real dates with the words 'Complete' (36
    rows) and the string '7/28/2026' (14 rows). The string is a date someone typed
    as text and is worth keeping; 'Complete' is a status, not a date, and becomes
    NULL -- the gates already record that it shipped.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def find_header(rows: list[tuple]) -> int:
    """Index of the header row.

    The sheets have a banner row above the header, and PI27.3 has two, so the
    header is located by content -- the first row carrying both 'Item' and
    'Release' -- rather than by a hard-coded offset that a new tab would break.
    """
    for i, row in enumerate(rows[:10]):
        labels = {str(v).strip().lower() for v in row if v is not None}
        if "item" in labels and "release" in labels:
            return i
    raise SystemExit("Could not find a header row containing 'Release' and 'Item'.")


def read_sheet(ws) -> tuple[list[dict], list[str]]:
    """Rows of the sheet as table-shaped dicts, plus warnings worth printing."""
    rows = list(ws.iter_rows(values_only=True))
    header_at = find_header(rows)
    header = [("" if v is None else str(v).strip()) for v in rows[header_at]]
    index = {name: j for j, name in enumerate(header) if name}

    missing = [h for h in GATE_MAP if h not in index]
    warnings = [f"{ws.title}: no '{h}' column; that gate imports as not passed."
                for h in missing]

    out: list[dict] = []
    # Sheets group rows under a banner that puts a name in the Release column and
    # nothing else -- PI27.3 has a 'BACKLOG' row followed by 19 items whose own
    # Release cell is blank. Those items belong to that section, so the banner is
    # remembered and applied to the rows beneath it. Without this they would all
    # import as "no wave" and stop being recognisable as backlog.
    section: str | None = None

    for excel_row, raw in enumerate(rows[header_at + 1 :], start=header_at + 2):
        if not any(v is not None and str(v).strip() for v in raw):
            continue

        def cell(name: str):
            j = index.get(name)
            return raw[j] if j is not None and j < len(raw) else None

        filled = [name for name in index if _text(cell(name))]
        if filled == ["Release"]:
            section = _text(cell("Release"))
            warnings.append(
                f"{ws.title} row {excel_row}: '{section}' section banner — "
                "applied to the rows below it, not imported as a row."
            )
            continue

        record: dict = {f: None for f in deployments.EDITABLE_FIELDS}
        record.update({g: False for g in deployments.GATE_FIELDS})
        record["PINumberRelease"] = pi_label(ws.title)

        for sheet_col, column in DETAIL_MAP.items():
            record[column] = _text(cell(sheet_col))

        # A row with no wave of its own inherits the section it sits under.
        if not record["ReleaseWave"] and section:
            record["ReleaseWave"] = section

        record["ReleaseDate"] = _as_date(cell("Release Date"))

        if record["Priority"]:
            key = record["Priority"].strip().lower()
            record["Priority"] = PRIORITY_MAP.get(key, record["Priority"].strip())

        # Gates: Y means passed, with the day left NULL because the sheet never
        # recorded one. Anything that is neither a pass nor a plain N is kept.
        residue: list[str] = []
        for sheet_col, gate in GATE_MAP.items():
            value = _text(cell(sheet_col))
            token = (value or "").strip().lower()
            record[gate] = token in _PASSED
            if token in _NOT_A_FLAG:
                residue.append(f"{sheet_col}: {value}")

        if residue:
            note = "; ".join(residue)
            record["Notes"] = f"{record['Notes']} | {note}" if record["Notes"] else note

        # A row with neither a component nor an item cannot be identified later.
        if not record["ComponentName"] and not record["Item"]:
            warnings.append(f"{ws.title} row {excel_row}: no Item and no Component Name — skipped.")
            continue

        record["_row"] = excel_row
        record["_sheet"] = ws.title
        out.append(record)

    return out, warnings


def key_of(record: dict) -> tuple[str, ...]:
    """The same natural key the app enforces, so the two cannot disagree."""
    return deployments.natural_key(record)


def describe(record: dict) -> str:
    name = record.get("ComponentName") or record.get("Item") or "(unnamed)"
    wave = record.get("ReleaseWave") or "-"
    passed = sum(1 for g in deployments.GATE_FIELDS if record.get(g))
    return f"{record['PINumberRelease']} w{wave} {name[:52]}  ({passed}/{len(deployments.GATE_FIELDS)} gates)"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", help="path to HDX Deployment Tracker.xlsx")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform the insert (without this, only report what would happen)",
    )
    args = parser.parse_args(argv)

    try:
        import openpyxl
    except ImportError:
        print("openpyxl is required: python -m pip install openpyxl", file=sys.stderr)
        return 1

    print(f"Warehouse: {ping()}")

    if not deployments.table_exists():
        print(
            f"\n{deployments.TRACKER} does not exist.\n"
            "Run sql/04_create_deployment_tracker.sql against the warehouse first.",
            file=sys.stderr,
        )
        return 1

    wb = openpyxl.load_workbook(args.workbook, data_only=True)

    records: list[dict] = []
    warnings: list[str] = []
    for sheet in SHEETS:
        if sheet not in wb.sheetnames:
            warnings.append(f"Sheet {sheet!r} is not in this workbook — skipped.")
            continue
        rows, sheet_warnings = read_sheet(wb[sheet])
        records.extend(rows)
        warnings.extend(sheet_warnings)
        print(f"Read {len(rows):>4} rows from {sheet}")

    skipped_sheets = [s for s in wb.sheetnames if s not in SHEETS]
    if skipped_sheets:
        print(f"Not imported (different shape): {', '.join(skipped_sheets)}")

    # Collisions inside the workbook. Inserting both would leave two rows sharing
    # a natural key, and the app refuses to edit either of them -- so the second
    # is reported and left out rather than quietly creating an uneditable pair.
    seen: dict[tuple, dict] = {}
    internal_dupes: list[tuple[dict, dict]] = []
    unique: list[dict] = []
    for record in records:
        key = key_of(record)
        if key in seen:
            internal_dupes.append((seen[key], record))
            continue
        seen[key] = record
        unique.append(record)

    existing = {
        key_of(r)
        for r in query(
            f"SELECT {', '.join(deployments.NATURAL_KEY)} FROM {deployments.TRACKER}"
        )
    }
    todo = [r for r in unique if key_of(r) not in existing]

    print(f"\nRows in the sheets   : {len(records)}")
    print(f"Duplicate keys within: {len(internal_dupes)}")
    print(f"Already in the table : {len(records) - len(internal_dupes) - len(todo)}")
    print(f"To insert            : {len(todo)}")

    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  ! {w}")

    if internal_dupes:
        print("\nDuplicate (PI, wave, item, component) inside the workbook — second one skipped:")
        for first, second in internal_dupes:
            print(f"  ~ {describe(second)}")
            print(f"      rows {first['_sheet']}!{first['_row']} and {second['_sheet']}!{second['_row']}")

    if not todo:
        print("\nNothing to insert — the table already has these rows.")
        return 0

    by_pi: dict[str, int] = {}
    for r in todo:
        by_pi[r["PINumberRelease"]] = by_pi.get(r["PINumberRelease"], 0) + 1
    print("\nBy release:")
    for pi, n in sorted(by_pi.items()):
        print(f"  {pi}: {n}")

    print("\nFirst rows to insert:")
    for record in todo[:8]:
        print(f"  + {describe(record)}")
    if len(todo) > 8:
        print(f"    ... and {len(todo) - 8} more")

    fully_passed = sum(
        1 for r in todo if all(r[g] for g in deployments.GATE_FIELDS)
    )
    untouched = sum(1 for r in todo if not any(r[g] for g in deployments.GATE_FIELDS))
    print(
        f"\nGate summary: {fully_passed} row(s) pass all {len(deployments.GATE_FIELDS)} gates, "
        f"{untouched} have passed none. Every imported gate date is NULL — "
        "the sheet recorded Y/N, not dates."
    )

    if not args.apply:
        print("\nRe-run with --apply to insert these rows.")
        return 0

    author = get_identity()["username"] or get_identity()["name"]
    # Naive UTC, matching every other datetime2 this app writes.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    print(f"\nInserting as {author} ...")

    placeholders_one = f"({','.join('?' * len(_INSERT_COLUMNS))})"
    inserted = 0
    for start in range(0, len(todo), BATCH_SIZE):
        batch = todo[start : start + BATCH_SIZE]
        values: list = []
        for record in batch:
            values.append(str(uuid.uuid4()))
            values.extend(deployments._values(record))
            values.extend([author, now, now, author])

        execute(
            f"INSERT INTO {deployments.TRACKER} ({', '.join(_INSERT_COLUMNS)}) "
            f"VALUES {','.join([placeholders_one] * len(batch))}",
            *values,
        )
        inserted += len(batch)
        print(f"  inserted {inserted}/{len(todo)}")

    total = query(f"SELECT COUNT(*) AS n FROM {deployments.TRACKER}")[0]["n"]
    print(f"\nInserted {inserted} row(s). The tracker now holds {total}.")
    print("Run sql/05_deployment_checks.sql to confirm nothing collided.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
