"""Compare two environments' dependency-graph table *contents*.

This is a data diff, not a schema diff. The S2T tab's "validate against DDL"
view asks whether a table's columns match a spec; this asks whether the rows in
one environment's orch.dependencygraph and another's actually agree -- which
edges exist in only one of them, and which flags disagree on the edges both
hold. Column shape only enters into it as a reason a field cannot be compared
(see queries.graph_contents), never as a difference in its own right.

**Two environments, not all four.** Comparing all of them at once produced a
grid nobody could read: an edge existing in only one environment made every one
of its columns trivially agree, three-way disagreements had no obvious "right"
answer to highlight against, and eleven fields across four environments could
not fit on screen. A pair has none of those problems -- every row is one
comparison with two sides -- and asking twice is cheaper than reading a grid.

Rows are matched on the natural key (Process, Dependency), case- and
whitespace-insensitively, because that is what identifies an edge across
environments. RowId cannot do the job: each environment's table was populated by
its own deployment, so the same edge carries a different uuid in each.
"""
from __future__ import annotations

from config import CONFIG
from endpoints import EndpointUnavailable
import queries


def _key(process: str, dependency) -> tuple[str, str]:
    """The natural key, normalised for matching across environments."""
    return (
        (process or "").strip().lower(),
        (dependency or "").strip().lower(),
    )


def _comparable(value):
    """Normalise a value for comparison.

    Strings are stripped, because trailing whitespace in one environment's copy
    is a data-entry artefact rather than a difference anyone wants reported. Bits
    have already become real bools in queries._to_bools.
    """
    if not isinstance(value, str):
        return value
    return value.strip()


def _read(env) -> tuple[str, list[dict]]:
    """Read one environment's rows, classifying failure rather than raising.

    Mirrors how s2t.py probes environments for its DDL view: one unreachable
    environment must leave the other three comparable, because "UAT is missing
    these edges" is exactly the answer someone opens this modal for and it must
    not be lost to PRD's endpoint being down.
    """
    if not env.configured:
        return "unavailable", []
    try:
        return "ok", queries.graph_contents(env)
    except EndpointUnavailable:
        return "unavailable", []
    except Exception as exc:
        # Permission and missing-table failures both surface as driver errors
        # here; the message decides which, the same way s2t._probe_env does.
        text = str(exc).lower()
        if "permission" in text or "denied" in text or "principal" in text:
            return "no_access", []
        return "unreadable", []


def _side(env) -> dict:
    """Read one side of the comparison and index it by natural key."""
    access, rows = _read(env)

    indexed: dict[tuple[str, str], dict] = {}
    duplicates = 0
    for row in rows:
        key = _key(row.get("Process", ""), row.get("Dependency"))
        if key in indexed:
            # Fabric Warehouse enforces no uniqueness constraint, so a table can
            # genuinely hold the same edge twice. Counted and surfaced rather
            # than quietly overwritten -- in a tool whose job is revealing drift,
            # silently dropping a duplicate row would be worse than reporting it.
            duplicates += 1
            continue
        indexed[key] = row

    return {
        "env": env,
        "access": access,
        "rows": indexed,
        "duplicates": duplicates,
        "columns": [c for c in queries.DIFF_COLUMNS if rows and c in rows[0]],
    }


def _summary(side: dict) -> dict:
    """The part of a side that goes over the wire."""
    env = side["env"]
    return {
        "key": env.key,
        "label": env.label,
        "access": side["access"],
        "rowCount": len(side["rows"]),
        "duplicates": side["duplicates"],
        "columns": side["columns"],
    }


def compare(left_key: str | None, right_key: str | None) -> dict:
    """Diff two environments' dependency graphs, edge by edge.

    Returns the two kinds of difference separately -- edges only one side has,
    and individual columns the two disagree about -- because they are different
    problems and read badly interleaved. Edges and columns that agree are
    counted, not listed.
    """
    left = _side(CONFIG.environment(left_key))
    right = _side(CONFIG.environment(right_key))

    result = {
        "left": _summary(left),
        "right": _summary(right),
        "comparable": left["access"] == "ok" and right["access"] == "ok",
        "compared": 0,
        "identical": 0,
        "onlyIn": [],
        "differences": [],
    }
    # One unreadable side means there is nothing to say about either. Reported as
    # the access states above rather than as an empty diff, which would read as
    # "these two agree".
    if not result["comparable"]:
        return result

    # Only columns both tables actually have can be compared at all. One that
    # exists on a single side is a schema difference, and this view is about
    # data -- reporting it as every row differing would drown the real answer.
    shared = [c for c in left["columns"] if c in right["columns"]]

    only_in: list[dict] = []
    differences: list[dict] = []
    identical = 0

    for key in sorted(set(left["rows"]) | set(right["rows"])):
        in_left = left["rows"].get(key)
        in_right = right["rows"].get(key)
        source = in_left or in_right
        process, dependency = source["Process"], source.get("Dependency")

        if in_left is None or in_right is None:
            only_in.append(
                {
                    "process": process,
                    "dependency": dependency,
                    "env": "right" if in_left is None else "left",
                }
            )
            continue

        differing = False
        for column in shared:
            left_value = _comparable(in_left.get(column))
            right_value = _comparable(in_right.get(column))
            if left_value == right_value:
                continue
            differing = True
            differences.append(
                {
                    "process": process,
                    "dependency": dependency,
                    "field": column,
                    "left": left_value,
                    "right": right_value,
                }
            )

        if not differing:
            identical += 1

    order = {c: i for i, c in enumerate(queries.DIFF_COLUMNS)}
    only_in.sort(key=lambda e: (e["process"], e["dependency"] or ""))
    # Grouped by edge, then in table-column order rather than alphabetically, so
    # an edge's several disagreements sit together and always in the same order.
    differences.sort(
        key=lambda d: (d["process"], d["dependency"] or "", order[d["field"]])
    )

    result["compared"] = len(set(left["rows"]) | set(right["rows"]))
    result["identical"] = identical
    result["onlyIn"] = only_in
    result["differences"] = differences
    result["sharedColumns"] = shared
    return result


