"""CRUD over the deployment tracker in WH_HDX_DE_Silver.deploy.

One row per component being taken through a release: what it is, who owns it,
and which of the eleven gates it has passed.

Like HDX.* and unlike dependencygraph, this table lives in the **warehouse**,
which accepts DML -- so this is real CRUD with no staging table and no publish
step. Unlike HDX.*, dg_tool created it, so it has a surrogate key and none of
the natural-key ambiguity s2t.py has to defend against.

## Why every gate is two columns

A gate is a `bit` (passed or not) plus a nullable `date` (the day it was passed).
The spreadsheet this table replaces recorded only Y/N, so for every imported row
the gate is known to have passed but the day is unknowable. One date column would
have forced a choice between inventing a date and discarding the fact. Gates
ticked in the app set both, so cycle-time reporting works going forward without
anyone having to backdate history.

Writes are guarded by the row's `LastModified`: a release is tracked by several
people at once, and an update here rewrites every field of the row, so a stale
read followed by a save would silently overwrite whoever ticked a gate in
between.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from warehouse import execute, query, query_one

TRACKER = "deploy.DeploymentTracker"

# What the row describes, in form order.
DETAIL_FIELDS = (
    "PINumberRelease",
    "ReleaseWave",
    "ReleaseDate",
    # Who asked for the work -- HDX, HFN, Finance. Free text with suggestions,
    # like the owner columns: the spreadsheet's spellings are the source of
    # truth and a closed list here would only fight them.
    "Requestor",
    "Item",
    "Priority",
    "ComponentName",
    "ComponentType",
)

# The eleven gates, in the order they are passed. Order matters: the UI renders
# its columns and its progress bar from this tuple, so there is one definition of
# what "how far along is it" means.
GATE_FIELDS = (
    "DataModelingComplete",
    "ReadyForCodeReview",
    "CodeReviewApproved",
    "DeployedToQA",
    "QAApproved",
    "DeployedToUAT",
    "UATApproved",
    "UATSmokeTestsApproved",
    "ReadyForProdDeployment",
    "DeployedToProd",
    "ProdSmokeTestsPassed",
)

# Each gate's companion date column.
GATE_DATE_FIELDS = tuple(f"{gate}Date" for gate in GATE_FIELDS)

# Each gate's companion "who passed it" column: initials, stamped automatically
# from the signed-in user (see set_gate) -- never hand-typed, so it is never
# offered as a suggestion or a form field the way the owner columns are.
GATE_BY_FIELDS = tuple(f"{gate}By" for gate in GATE_FIELDS)

OWNER_FIELDS = ("DataModeling", "Developer", "QAApproval", "UATApprover")

# Interleaved so a gate's flag, date and "who" stay adjacent in the table and
# in every statement built from this tuple.
_GATE_COLUMNS = tuple(
    column for gate in GATE_FIELDS for column in (gate, f"{gate}Date", f"{gate}By")
)

EDITABLE_FIELDS = DETAIL_FIELDS + _GATE_COLUMNS + OWNER_FIELDS + ("Notes",)

_DATE_FIELDS = ("ReleaseDate",) + GATE_DATE_FIELDS
_BOOL_FIELDS = GATE_FIELDS

_AUDIT_FIELDS = ("CreatedBy", "CreatedDate", "LastModified", "LastModifiedBy")

_SELECT = f"""
SELECT DeploymentId, {", ".join(EDITABLE_FIELDS)}, {", ".join(_AUDIT_FIELDS)}
FROM {TRACKER}
"""

# Oldest release first -- 27.2 precedes 27.3, and a release plan reads forwards --
# then the most urgent work inside it. Priority sorts by meaning rather than
# alphabetically: "High" before "Low" is not something ORDER BY Priority would
# give. Waves sort numerically where they are numbers, so wave 2 comes before
# wave 10 and BACKLOG lands last.
_ORDER = """
ORDER BY CASE WHEN PINumberRelease IS NULL THEN 1 ELSE 0 END,
         PINumberRelease,
         CASE WHEN TRY_CAST(ReleaseWave AS int) IS NULL THEN 1 ELSE 0 END,
         TRY_CAST(ReleaseWave AS int),
         ReleaseWave,
         CASE LOWER(LTRIM(RTRIM(ISNULL(Priority, ''))))
              WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         Item,
         ComponentName
"""


class NotFound(RuntimeError):
    """No row with that id."""


class DuplicateKey(RuntimeError):
    """A create would collide with an existing row."""


class StaleWrite(RuntimeError):
    """The row changed after the client read it, so saving would silently clobber."""

    def __init__(self, message: str, who: str | None, when: str | None):
        super().__init__(message)
        self.who = who
        self.when = when


def _now() -> datetime:
    # Naive UTC, matching every other datetime2 this app writes.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _stamp(value: datetime | None) -> str | None:
    """The comparison form of LastModified.

    datetime2(6) is exactly Python's microsecond precision, so a value read twice
    formats identically and this comparison has no truncation risk.
    """
    return value.isoformat() if value is not None else None


def _check_fresh(current: dict, expected: str | None) -> None:
    """Refuse the write if the row moved since the client read it.

    `expected` of None means the caller supplied no version, which is treated as
    an explicit override -- useful for scripts. The UI always sends one.
    """
    if expected is None:
        return

    actual = _stamp(current.get("LastModified"))
    # Normalise "" to None so a row that has never been stamped compares equal to
    # a client that round-tripped a null.
    if (expected or None) == actual:
        return

    who = current.get("LastModifiedBy") or "someone else"
    raise StaleWrite(
        f"{label_of(current)} was changed by {who} at "
        f"{actual or 'an unknown time'}, after you loaded it. Your save was not "
        "applied — reload to see their change, then redo yours.",
        who=who,
        when=actual,
    )


def label_of(row: dict) -> str:
    """How to name a row in a message.

    ComponentName is nullable -- most planned rows have only an Item -- so error
    text falls back to it rather than saying "None was changed by...".
    """
    return row.get("ComponentName") or row.get("Item") or "This row"


def _norm(value) -> str | None:
    """Trim, and treat blank as NULL, so "unset" has one representation."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_date(value) -> date | None:
    """Accept a date, a 'YYYY-MM-DD' string, or blank/None for "not known"."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value).strip())


def _as_bool(value) -> bool:
    """Gate flags are NOT NULL, so an absent value means "not passed"."""
    return bool(value)


def _values(payload: dict) -> list:
    """Editable fields in EDITABLE_FIELDS order, normalised for the driver."""
    out = []
    for field in EDITABLE_FIELDS:
        value = payload.get(field)
        if field in _BOOL_FIELDS:
            out.append(_as_bool(value))
        elif field in _DATE_FIELDS:
            out.append(_as_date(value))
        else:
            out.append(_norm(value))
    return out


def _to_python(row: dict) -> dict:
    """Turn the driver's 0/1 bits into real booleans."""
    for gate in GATE_FIELDS:
        if gate in row:
            row[gate] = bool(row[gate])
    return row


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------


def list_rows(release: str | None = None) -> list[dict]:
    """Every tracked component, or just one release's."""
    if release:
        rows = query(f"{_SELECT} WHERE PINumberRelease = ? {_ORDER}", release)
    else:
        rows = query(f"{_SELECT} {_ORDER}")
    return [_to_python(r) for r in rows]


def get(deployment_id: str) -> dict | None:
    row = query_one(f"{_SELECT} WHERE DeploymentId = ?", deployment_id)
    return _to_python(row) if row else None


def table_exists() -> bool:
    """Whether the tracker table has been created yet.

    Checked by preflight so a machine where sql/04 has not been run says so in
    plain English, rather than failing with an "Invalid object name" on first click.
    """
    schema, _, table = TRACKER.partition(".")
    found = query_one(
        """
        SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        """,
        schema,
        table,
    )
    return found is not None


def releases() -> list[dict]:
    """Releases present, with how many components each tracks and how many shipped.

    Feeds the release picker, so an empty tracker still offers something sensible
    and a finished release is visibly finished without opening it.
    """
    return query(
        f"""
        SELECT PINumberRelease AS release,
               COUNT(*) AS components,
               SUM(CASE WHEN DeployedToProd = 1 THEN 1 ELSE 0 END) AS deployed,
               MIN(ReleaseDate) AS releaseDate
        FROM {TRACKER}
        WHERE PINumberRelease IS NOT NULL AND LTRIM(RTRIM(PINumberRelease)) <> ''
        GROUP BY PINumberRelease
        ORDER BY PINumberRelease
        """
    )


NATURAL_KEY = ("PINumberRelease", "ReleaseWave", "Item", "ComponentName", "ComponentType")


def natural_key(payload: dict) -> tuple[str, ...]:
    """The comparison form of the natural key, for callers that dedupe in Python."""
    return tuple((payload.get(f) or "").strip().lower() for f in NATURAL_KEY)


def _find_natural_key(payload: dict, exclude_id: str | None = None) -> dict | None:
    """Look up a row by its natural key, case- and blank-insensitively.

    All five parts are needed. The same component ships in several waves of one
    PI; many planned rows have an Item but no component name yet; and ComponentType
    is what distinguishes two rows that change the same component in the same wave
    for different reasons -- PI27.2 tracks
    SP_Create_GC_Item_Prosthetic_Sheaths twice in wave 1, once for "units per
    package" and once for "unit of measure". Without the type those two collapse
    into one and a real row is lost.

    This is a duplicate-detection heuristic, not an addressing key: rows are always
    addressed by DeploymentId, so including an editable field here costs nothing.
    """
    sql = f"""
        SELECT DeploymentId FROM {TRACKER}
        WHERE LOWER(LTRIM(RTRIM(ISNULL(PINumberRelease, '')))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(ReleaseWave, '')))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(Item, '')))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(ComponentName, '')))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(ComponentType, '')))) = ?
    """
    params: list = list(natural_key(payload))
    if exclude_id:
        sql += " AND DeploymentId <> ?"
        params.append(exclude_id)
    return query_one(sql, *params)


# --------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------


def _require_row(deployment_id: str) -> dict:
    row = get(deployment_id)
    if row is None:
        raise NotFound("That component is no longer in the tracker — someone deleted it.")
    return row


def _require_unique(payload: dict, exclude_id: str | None = None) -> None:
    if _find_natural_key(payload, exclude_id):
        where = payload.get("PINumberRelease") or "no release"
        wave = payload.get("ReleaseWave")
        raise DuplicateKey(
            f"{label_of(payload)} is already tracked in {where}"
            f"{f' wave {wave}' if wave else ''}."
        )


def create(payload: dict, author: str) -> str:
    _require_unique(payload)

    deployment_id = str(uuid.uuid4())
    now = _now()
    placeholders = ",".join("?" * (len(EDITABLE_FIELDS) + 5))
    execute(
        f"""
        INSERT INTO {TRACKER} (
            DeploymentId, {", ".join(EDITABLE_FIELDS)},
            CreatedBy, CreatedDate, LastModified, LastModifiedBy
        ) VALUES ({placeholders})
        """,
        deployment_id,
        *_values(payload),
        author,
        now,
        now,
        author,
    )
    return deployment_id


def update(
    deployment_id: str, payload: dict, author: str, expected: str | None = None
) -> None:
    current = _require_row(deployment_id)
    _check_fresh(current, expected)
    _require_unique(payload, exclude_id=deployment_id)

    assignments = ", ".join(f"{f} = ?" for f in EDITABLE_FIELDS)
    execute(
        f"""
        UPDATE {TRACKER}
        SET {assignments}, LastModified = ?, LastModifiedBy = ?
        WHERE DeploymentId = ?
        """,
        *_values(payload),
        _now(),
        author,
        deployment_id,
    )


def initials_of(name: str | None) -> str | None:
    """'Nicole Sood' -> 'NS', for the <Gate>By columns.

    First letter of each space-separated part, uppercased. A single-word name
    (a username with no display name behind it) still yields something rather
    than nothing.
    """
    name = _norm(name)
    if not name:
        return None
    letters = "".join(part[0] for part in name.split() if part)
    return (letters or name[0]).upper()[:10]


def set_gate(
    deployment_id: str,
    gate: str,
    passed: bool,
    passed_on: date | None,
    author: str,
    signer: str | None = None,
    expected: str | None = None,
) -> None:
    """Set one gate, its date and who passed it, leaving every other field alone.

    Separate from update() because ticking a checkbox in the grid is the common
    action by a wide margin, and routing it through a full-row update would make
    a single click capable of overwriting fields the clicker never saw.

    Clearing a gate clears its date and its "who" too: either one surviving
    with the flag off would claim the gate was passed by someone on a day it
    was not.

    `author` is the identity LastModifiedBy records (an email, matching every
    other row in this table); `signer` is that same person's display name,
    which is what initials_of() needs to produce something readable. They are
    the same signed-in user, just two forms of their identity -- there is no
    second person involved.
    """
    if gate not in GATE_FIELDS:
        raise ValueError(f"Unknown gate: {gate!r}")

    current = _require_row(deployment_id)
    _check_fresh(current, expected)

    # `gate` is checked against GATE_FIELDS above, so it is never user input by
    # the time it reaches the statement. All values are still ? parameters.
    execute(
        f"""
        UPDATE {TRACKER}
        SET {gate} = ?, {gate}Date = ?, {gate}By = ?, LastModified = ?, LastModifiedBy = ?
        WHERE DeploymentId = ?
        """,
        bool(passed),
        _as_date(passed_on) if passed else None,
        initials_of(signer) if passed else None,
        _now(),
        author,
        deployment_id,
    )


def delete(deployment_id: str, expected: str | None = None) -> dict:
    """Remove a tracked component. Returns the row that was deleted.

    A real delete, unlike the dependency graph's deactivate: nothing downstream
    reads this table, so a row removed here leaves nothing dangling. The UI
    confirms by name first.
    """
    current = _require_row(deployment_id)
    _check_fresh(current, expected)
    execute(f"DELETE FROM {TRACKER} WHERE DeploymentId = ?", deployment_id)
    return current


# --------------------------------------------------------------------------
# Suggestions for the form's datalists
# --------------------------------------------------------------------------

# Offered as suggestions rather than a closed dropdown, for the same reason the
# S2T tab does it: these rows were transcribed from a spreadsheet whose values do
# not match a list we invent -- Component Type alone has 79 distinct spellings in
# PI27.2 -- and silently rewriting someone's entry would be worse than tolerating
# the variants.
CANONICAL = {
    "Priority": ["High", "Medium", "Low"],
    # ComponentType is deliberately not offered here: the UI now presents it as a
    # closed dropdown (COMPONENT_TYPES in web/src/types.ts), not a suggestion, so
    # there is exactly one place that list is defined.
}

_SUGGESTED_FIELDS = ("PINumberRelease", "ReleaseWave", "Requestor")


def _distinct(field: str) -> list[str]:
    return [
        r["v"]
        for r in query(
            f"""
            SELECT DISTINCT {field} AS v FROM {TRACKER}
            WHERE {field} IS NOT NULL AND LTRIM(RTRIM({field})) <> ''
            """
        )
    ]


def suggestions() -> dict[str, list[str]]:
    """Canonical values first, then whatever the data already uses."""
    result: dict[str, list[str]] = {}

    for field, canonical in CANONICAL.items():
        extra = sorted(v for v in _distinct(field) if v not in canonical)
        result[field] = canonical + extra

    # People are offered as one pooled list: the same names appear in all four
    # owner columns, and four half-populated lists would just mean more typing.
    people = sorted({v for f in OWNER_FIELDS for v in _distinct(f)})
    for field in OWNER_FIELDS:
        result[field] = people

    for field in _SUGGESTED_FIELDS:
        result[field] = sorted(_distinct(field))
    return result
