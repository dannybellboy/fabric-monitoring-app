"""Graph-level validation for the dependency table.

The notebook has no guard against these mistakes, and the orchestrator can only
discover a cycle by deadlocking at run time. Since the app is now the front door
for edits, it checks the whole graph on every write: cheap at 192 rows, and it
catches the class of error that is most expensive to debug in production.

Rules that BLOCK a save:
  * a process depending on itself
  * a dependency cycle (A needs B needs A)
  * a duplicate (Process, Dependency) pair -- the publish MERGE matches on that
    pair, so a duplicate makes the merge ambiguous
  * a stored proc with no WarehouseName to run it in

Rules that WARN only:
  * a dependency that is not itself a process in the table (usually a typo, but
    legitimately absent for externally-triggered upstreams)
  * a non-stored-proc row that names a warehouse (ignored by the orchestrator)
"""
from __future__ import annotations

from models import Issue


def _key(value: str | None) -> str:
    return (value or "").strip().lower()


def natural_key(row: dict) -> tuple[str, str]:
    """The (Process, Dependency) pair the publish MERGE matches on."""
    return _key(row.get("Process")), _key(row.get("Dependency"))


def find_cycles(rows: list[dict]) -> list[list[str]]:
    """Return dependency cycles among active rows, as lists of process names.

    Edges point Process -> Dependency ("must run after"), so any cycle here is a
    set of processes that can never all be satisfied. Inactive rows are excluded:
    deactivating a row is exactly how you break a cycle, so counting it would
    make the cycle unfixable through the UI.
    """
    graph: dict[str, set[str]] = {}
    display: dict[str, str] = {}

    for row in rows:
        if not row.get("isActive"):
            continue
        process, dependency = _key(row.get("Process")), _key(row.get("Dependency"))
        if not process:
            continue
        display.setdefault(process, (row.get("Process") or "").strip())
        graph.setdefault(process, set())
        if dependency:
            display.setdefault(dependency, (row.get("Dependency") or "").strip())
            graph.setdefault(dependency, set())
            graph[process].add(dependency)

    cycles: list[list[str]] = []
    seen_signatures: set[frozenset[str]] = set()
    state: dict[str, int] = {}  # 0/absent = unvisited, 1 = on stack, 2 = done
    stack: list[str] = []

    def visit(node: str) -> None:
        state[node] = 1
        stack.append(node)
        for neighbour in sorted(graph.get(node, ())):
            if state.get(neighbour, 0) == 1:
                # Found a back edge: the cycle is the stack from `neighbour` on.
                cycle = stack[stack.index(neighbour):]
                signature = frozenset(cycle)
                if signature not in seen_signatures:
                    seen_signatures.add(signature)
                    cycles.append([display.get(n, n) for n in cycle])
            elif state.get(neighbour, 0) == 0:
                visit(neighbour)
        stack.pop()
        state[node] = 2

    for node in sorted(graph):
        if state.get(node, 0) == 0:
            visit(node)

    return cycles


def validate_graph(rows: list[dict]) -> list[Issue]:
    """Validate the full row set, returning blocking errors and warnings."""
    issues: list[Issue] = []
    processes = {_key(r.get("Process")) for r in rows if _key(r.get("Process"))}

    seen: dict[tuple[str, str], str] = {}
    for row in rows:
        row_id = row.get("RowId")
        process = (row.get("Process") or "").strip()
        dependency = (row.get("Dependency") or "").strip()

        if not process:
            issues.append(Issue(level="error", message="Process is required.", rowId=row_id))
            continue

        if dependency and _key(process) == _key(dependency):
            issues.append(
                Issue(
                    level="error",
                    message=f"{process} depends on itself.",
                    rowId=row_id,
                )
            )

        key = natural_key(row)
        if key in seen:
            label = f"{process} -> {dependency or '(no dependency)'}"
            issues.append(
                Issue(
                    level="error",
                    message=f"Duplicate row: {label} already exists.",
                    rowId=row_id,
                )
            )
        else:
            seen[key] = row_id or ""

        if row.get("isStoredPro") and not (row.get("WarehouseName") or "").strip():
            issues.append(
                Issue(
                    level="error",
                    message=f"{process} is a stored proc but has no WarehouseName.",
                    rowId=row_id,
                )
            )

        if not row.get("isStoredPro") and (row.get("WarehouseName") or "").strip():
            issues.append(
                Issue(
                    level="warning",
                    message=(
                        f"{process} is not a stored proc, so WarehouseName "
                        f"'{row.get('WarehouseName')}' is ignored by the orchestrator."
                    ),
                    rowId=row_id,
                )
            )

        if dependency and _key(dependency) not in processes:
            issues.append(
                Issue(
                    level="warning",
                    message=(
                        f"'{dependency}' is a dependency of {process} but is not "
                        "itself a process in the table."
                    ),
                    rowId=row_id,
                )
            )

    for cycle in find_cycles(rows):
        path = " -> ".join(cycle + [cycle[0]])
        issues.append(Issue(level="error", message=f"Dependency cycle: {path}"))

    return issues


def validate_change(rows: list[dict], changed: dict, row_id: str | None) -> list[Issue]:
    """Validate the graph as it *would be* after applying `changed`.

    `row_id` is None for a create, or the id of the row being replaced. Only
    issues attributable to the change are returned, so a save is never blocked by
    a pre-existing problem somewhere else in the table.
    """
    before = validate_graph(rows)

    projected = [r for r in rows if r.get("RowId") != row_id]
    projected.append({**changed, "RowId": row_id or "__new__"})
    after = validate_graph(projected)

    existing = {(i.level, i.message) for i in before}
    return [i for i in after if (i.level, i.message) not in existing]
