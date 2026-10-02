"""Request/response models.

Field names deliberately keep the table's exact casing (readyForUAT, isStoredPro,
createdDate, ...) so the API, the UI and the Lakehouse columns all line up 1:1.
Renaming them to snake_case would only add a mapping layer for a data team that
already reads this table directly.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# The 12 columns that describe the process. Audit columns are server-managed and
# drift is computed from exactly this set -- see queries.BUSINESS_COLUMNS.

# One cron field: '*', a number, a range (a-b), a step (*/n or a-b/n), or a
# comma list of those. Structural only -- it doesn't check that e.g. an hour
# field stays within 0-23, just that it looks like a cron field.
_CRON_FIELD = re.compile(
    r"^(\*|[0-9]+)(-[0-9]+)?(/[0-9]+)?(,(\*|[0-9]+)(-[0-9]+)?(/[0-9]+)?)*$")


def _clean(value: str | None) -> str | None:
    """Trim, and treat an empty/whitespace string as NULL.

    The table uses NULL (not '') for "no dependency" / "not applicable", and the
    publish MERGE matches on NULL-vs-NULL, so a stray empty string would create a
    second row that looks identical in the UI.
    """
    if value is None:
        return None
    value = value.strip()
    return value or None


class RowIn(BaseModel):
    """Editable fields of a dependency-graph row."""

    Process: str = Field(min_length=1, max_length=200)
    Dependency: str | None = Field(default=None, max_length=200)
    readyForUAT: bool = False
    readyForProd: bool = False
    isStoredPro: bool = False
    RunTimes: str | None = Field(default=None, max_length=100)
    RequiresHashing: bool = False
    isGold: bool = False
    WarehouseName: str | None = Field(default=None, max_length=200)
    WorkspacePrefix: str | None = Field(default="WS_HDX_DE_", max_length=100)
    NeedsTimestamp: bool = False
    lookbackRequired: bool = False
    isActive: bool = True

    @field_validator("Process")
    @classmethod
    def _process_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Process is required")
        return v

    @field_validator("Dependency", "WarehouseName", "WorkspacePrefix", "RunTimes")
    @classmethod
    def _blank_to_null(cls, v: str | None) -> str | None:
        return _clean(v)

    @field_validator("RunTimes")
    @classmethod
    def _valid_cron(cls, v: str | None) -> str | None:
        if v is None:
            return None
        fields = v.split()
        if len(fields) != 5 or not all(_CRON_FIELD.match(f) for f in fields):
            raise ValueError(
                "RunTimes must be a 5-field cron expression (minute hour day-of-month "
                f"month day-of-week), e.g. '0 9 * * *'; got {v!r}"
            )
        # Normalised to single spaces so equivalent input reads identically.
        return " ".join(fields)


class GraphRow(BaseModel):
    """A dependency-graph edge read straight from one environment's own
    published table (GET /api/graph), not the editable orch.dependencygraph.

    Deliberately has none of RowIn's validators: this is a read-only view of
    data dg_tool doesn't write, so it must never reject a row just because a
    value already sitting in the table doesn't match the shape the edit form
    enforces on the way in.

    Only the columns graph_rows() actually selects -- a curated subset for the
    Lineage/Health tabs, not the full editable shape. RowId and the audit/
    lookbackRequired columns belong to Row below, which reads the editable
    table instead.
    """

    Process: str
    Dependency: str | None = None
    readyForUAT: bool = False
    readyForProd: bool = False
    isStoredPro: bool = False
    RunTimes: str | None = None
    RequiresHashing: bool = False
    isGold: bool = False
    WarehouseName: str | None = None
    WorkspacePrefix: str | None = None
    NeedsTimestamp: bool = False
    isActive: bool = True


class Row(GraphRow):
    """A dependency-graph row as returned to the UI.

    Extends GraphRow, not RowIn, and so inherits none of RowIn's validators --
    which is the point. Those validators police what someone types into the edit
    form; applying them to rows already sitting in a table means one bad value
    makes the row unreadable rather than merely wrong.

    RowId stays required: every environment's table carries a real one.
    """

    RowId: str
    lookbackRequired: bool = False
    LastModifiedDate: datetime | None = None
    CreatedBy: str | None = None
    createdDate: datetime | None = None
    ModifiedBy: str | None = None


class Issue(BaseModel):
    """A validation finding. `blocking` issues prevent a save; others warn."""

    level: Literal["error", "warning"]
    message: str
    rowId: str | None = None


class ValidationReport(BaseModel):
    issues: list[Issue] = []

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]


class Identity(BaseModel):
    # Which build is running, so support questions have an answer.
    version: str = "unknown"
    name: str
    username: str
    warehouse: str
    monitoringConfigured: bool
    # Whether this user holds the Fabric Admin role on the workspace named by
    # `adminEnv`, which is what permits editing a dependency graph outside DEV.
    # The server enforces it regardless (roles.require_admin); this tells
    # the UI whether to offer the controls, so it can explain the restriction up
    # front instead of letting someone fill in a form that will be refused, and
    # marks the masthead so an admin can see they are holding the sharp end.
    isAdmin: bool = False
    # Label of the environment whose Admin role grants that, for the UI's wording.
    adminEnv: str = "PRD"


class ProcessStatus(BaseModel):
    """A row of ProcessExecutionStatus, enriched for the health dashboard."""

    Process: str
    Status: str | None = None
    LastRunTime: datetime | None = None
    LastSuccess: datetime | None = None
    RunInstanceId: str | None = None
    LastCheckedTime: datetime | None = None
    RetryCount: int | None = None

    # Staleness is computed server-side. The stored values are naive UTC, and a
    # browser parsing a naive ISO string treats it as local time -- which would
    # skew every age by the UTC offset. Both sides of this subtraction are UTC.
    daysSinceSuccess: int | None = None
    hoursSinceRun: int | None = None

    # From dependencygraph. False means the orchestrator's graph has no row for
    # this process, so the status row is left over from a rename or a removal.
    inGraph: bool = False
    # Promotion flags, true when *any* of the process's rows carry them -- the
    # same "any edge promoted" rule the orchestrator applies.
    readyForUAT: bool | None = None
    readyForProd: bool | None = None
    isActive: bool | None = None


class EnvironmentInfo(BaseModel):
    """One environment the Health tab can read."""

    key: str
    label: str
    # False when workspace_id / sql_endpoint have not been filled in yet. The UI
    # lists it as unavailable rather than hiding it, so a missing environment is
    # visible instead of looking like it does not exist.
    configured: bool
    # The column NB_Orchestrator gates on here; null for DEV and QA.
    promotionColumn: str | None = None
    # Whether this environment's dependency graph can be edited at all: its table
    # has to accept DML (so not a lakehouse copy) and carry a RowId to address
    # rows by. Independent of *who* is asking; an admin is additionally required
    # for anything but DEV. See queries.graph_editable().
    editable: bool = False
    # Whether this environment's ProcessExecutionStatus table can be written at
    # all -- false where it is a lakehouse copy, which is read-only however the
    # request is phrased. Like `editable`, this describes the table and not the
    # caller: the Health tab additionally requires an admin to offer "reset retry
    # count" outside DEV. See queries.status_writable().
    statusWritable: bool = False


class GraphDiffSide(BaseModel):
    """One environment in a pairwise comparison."""

    key: str
    label: str
    # "ok", "no_access", "unavailable" (not configured or its endpoint could not
    # be resolved) or "unreadable".
    access: str = "ok"
    rowCount: int = 0
    # Rows sharing a (Process, Dependency) with an earlier row. Fabric Warehouse
    # enforces no uniqueness, so this can be non-zero; only the first is compared.
    duplicates: int = 0
    # Which comparable columns this environment's table actually has.
    columns: list[str] = []


class GraphDiffOnlyIn(BaseModel):
    """An edge that exists on one side of the comparison and not the other."""

    process: str
    dependency: str | None = None
    # "left" or "right" -- which side has it.
    env: str


class GraphDiffDifference(BaseModel):
    """One column of one edge that the two environments disagree about.

    Deliberately flat -- one per (edge, column) rather than nested per edge --
    because the UI renders exactly this: one row per disagreement, with the two
    environments as its two value columns.
    """

    process: str
    dependency: str | None = None
    field: str
    left: Any = None
    right: Any = None


class GraphDiff(BaseModel):
    """Pairwise comparison of two environments' dependency-graph contents.

    Two environments rather than all four: comparing everything at once meant an
    edge present in only one environment made all of its columns trivially
    agree, a three-way disagreement had no "right" answer to highlight against,
    and the grid could not fit on screen. See graph_diff.py.

    Split into the two kinds of difference rather than one table of everything,
    since an edge that only one side has and an edge whose flags disagree are
    different problems. Edges and columns that agree are counted, not listed.
    """

    left: GraphDiffSide
    right: GraphDiffSide
    # False when either side could not be read; the diff lists are then empty
    # because there is nothing to say, which must not read as "they agree".
    comparable: bool = False
    # Columns both tables have. One present on a single side is a schema
    # difference, and this view is about data, so it is excluded.
    sharedColumns: list[str] = []
    # Distinct edges across both sides.
    compared: int = 0
    # Edges both sides have, agreeing on every shared column.
    identical: int = 0
    onlyIn: list[GraphDiffOnlyIn] = []
    differences: list[GraphDiffDifference] = []


class GraphApplyRequest(BaseModel):
    """Copy one edge from one environment to another, as the diff view offers.

    Whole-row, not per-field. The unit someone reconciles is an edge: applying
    one column and leaving its neighbours disagreeing produces a row that
    matches neither side, which is a worse state than the one being fixed.
    """

    # Environment keys. `source` is the side being treated as correct.
    source: str
    target: str
    process: str = Field(min_length=1)
    dependency: str | None = None


class GraphApplyResult(BaseModel):
    process: str
    dependency: str | None = None
    source: str
    target: str
    # "created" when the target had no such edge, "updated" when it did and
    # something changed, "unchanged" when the two already agreed.
    action: Literal["created", "updated", "unchanged"]
    # Columns actually written, for the confirmation message. Empty on
    # "created" (everything was written) and on "unchanged".
    changed: list[str] = []


class StatusReport(BaseModel):
    # Which environment this report describes.
    env: str
    rows: list[ProcessStatus] = []
    # In the graph but with no status row at all: never run, or never tracked.
    untracked: list[str] = []
    # Server clock at read time, so the UI can say how fresh the picture is.
    generatedAt: datetime


# ---------------------------------------------------------------------------
# Source-to-target spec (HDX.Table_Metadata / HDX.Table_Columns)
# ---------------------------------------------------------------------------


class S2TTarget(BaseModel):
    target: str
    mappings: int


class S2TTableRef(BaseModel):
    """One mapped table in the picker."""

    table_name: str
    columns: int
    load_method: str | None = None
    workflow: str | None = None
    procedure_name: str | None = None
    last_modified: datetime | None = None


class S2TSourceRef(BaseModel):
    """One source table feeding a mapped table, and how many columns come from it."""

    table_name: str
    columns: int


class S2TProcedureTable(BaseModel):
    """What one stored proc builds, for the Lineage diagram's labels.

    The dependency graph names processes by procedure; this is the only place that
    knows which table each procedure actually populates.
    """

    procedure_name: str
    table_name: str
    medallion_layer: str
    sources: list[S2TSourceRef] = []


class S2TMetadataIn(BaseModel):
    """Editable metadata fields. The key travels separately."""

    load_method: str | None = None
    procedure_name: str | None = None
    workflow: str | None = None
    base_table_logic: str | None = None
    join_logic: str | None = None
    filter_logic: str | None = None
    table_description: str | None = None


class S2TMetadata(S2TMetadataIn):
    table_name: str
    medallion_layer: str
    last_modified: datetime | None = None
    last_modified_by: str | None = None


class S2TColumnIn(BaseModel):
    column_ordinal: int | None = None
    data_type: str | None = None
    not_null: bool | None = None
    field_category: str | None = None
    transformation: str | None = None
    source_table_name: str | None = None
    source_column_name: str | None = None
    mapping_status: str | None = None
    dev_status: str | None = None
    change_requiring_update: bool | None = None
    business_description: str | None = None


class S2TColumn(S2TColumnIn):
    table_name: str
    column_name: str
    medallion_layer: str
    last_modified: datetime | None = None
    last_modified_by: str | None = None


class S2TDuplicateColumn(BaseModel):
    columnName: str
    count: int


class S2TDuplicates(BaseModel):
    """Ambiguity in this mapping. Any non-empty field blocks the matching writes."""

    metadataRows: int = 1
    duplicateColumns: list[S2TDuplicateColumn] = []


class S2TMapping(BaseModel):
    metadata: S2TMetadata | None = None
    columns: list[S2TColumn] = []
    duplicates: S2TDuplicates = S2TDuplicates()


class S2TEnvColumn(BaseModel):
    """One column's live shape in one environment, as seen by INFORMATION_SCHEMA."""

    access: Literal["ok", "no_access", "unavailable"] = "ok"
    present: bool
    data_type: str | None = None
    not_null: bool | None = None
    matches: bool


class S2TValidationColumn(BaseModel):
    column_name: str
    mapped_data_type: str | None = None
    mapped_not_null: bool | None = None
    environments: dict[str, S2TEnvColumn]


class S2TValidation(BaseModel):
    """Result of diffing a mapping against each environment's live DDL."""

    environments: list[str]
    access: dict[str, Literal["ok", "no_access", "unavailable"]]
    table_found: dict[str, bool]
    columns: list[S2TValidationColumn]
    matches: bool


class S2TValidateAllRequest(BaseModel):
    targets: list[str] | str | None = None
    environments: list[str] | None = None


class S2TValidateAllResponse(BaseModel):
    generatedAt: datetime
    summary: dict[str, dict[str, int]]
    results: dict[str, list[dict]]


class S2TMetadataRequest(BaseModel):
    """Create/update payload for a metadata row."""

    table_name: str = Field(min_length=1, max_length=255)
    medallion_layer: str = Field(min_length=1, max_length=20)
    values: S2TMetadataIn = S2TMetadataIn()
    # The last_modified the client read. The server refuses the write if the row
    # has moved since. Omitting it is an explicit override; the UI always sends it.
    expected_last_modified: str | None = None

    @field_validator("table_name", "medallion_layer")
    @classmethod
    def _trim(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("required")
        return v


class S2TColumnRequest(BaseModel):
    """Create/update payload for a column row."""

    table_name: str = Field(min_length=1, max_length=255)
    medallion_layer: str = Field(min_length=1, max_length=50)
    column_name: str = Field(min_length=1, max_length=255)
    # Set to rename on update; ignored on create.
    rename_to: str | None = Field(default=None, max_length=255)
    values: S2TColumnIn = S2TColumnIn()
    expected_last_modified: str | None = None

    @field_validator("table_name", "medallion_layer", "column_name")
    @classmethod
    def _trim_keys(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("required")
        return v


# ---------------------------------------------------------------------------
# Deployment tracker (deploy.DeploymentTracker)
# ---------------------------------------------------------------------------


class DeploymentIn(BaseModel):
    """Editable fields of a tracked component.

    Each gate is a pair: `<Gate>` says whether it was passed, `<Gate>Date` says
    when, or null when the day is not known -- which is the case for every row
    imported from the spreadsheet, where only Y/N was ever recorded.

    Nothing is required. A row is added the moment someone knows an item is
    coming, long before the component, the release date or the owners are
    settled; 65 of the 73 planned rows in PI27.3 have no component name at all.
    """

    PINumberRelease: str | None = Field(default=None, max_length=50)
    # The sheet's own Release column: a wave within the PI (1..15, or BACKLOG).
    ReleaseWave: str | None = Field(default=None, max_length=20)
    ReleaseDate: date | None = None
    # Who asked for the work -- HDX, HFN, Finance.
    Requestor: str | None = Field(default=None, max_length=50)
    Item: str | None = Field(default=None, max_length=400)
    Priority: str | None = Field(default=None, max_length=20)
    ComponentName: str | None = Field(default=None, max_length=400)
    ComponentType: str | None = Field(default=None, max_length=400)

    # <Gate>By: initials of whoever ticked it, stamped automatically from the
    # signed-in user (see server/deployments.py:set_gate) -- never hand-typed,
    # so it carries no field_validator of its own and no form field.
    DataModelingComplete: bool = False
    DataModelingCompleteDate: date | None = None
    DataModelingCompleteBy: str | None = Field(default=None, max_length=10)
    ReadyForCodeReview: bool = False
    ReadyForCodeReviewDate: date | None = None
    ReadyForCodeReviewBy: str | None = Field(default=None, max_length=10)
    CodeReviewApproved: bool = False
    CodeReviewApprovedDate: date | None = None
    CodeReviewApprovedBy: str | None = Field(default=None, max_length=10)
    DeployedToQA: bool = False
    DeployedToQADate: date | None = None
    DeployedToQABy: str | None = Field(default=None, max_length=10)
    QAApproved: bool = False
    QAApprovedDate: date | None = None
    QAApprovedBy: str | None = Field(default=None, max_length=10)
    DeployedToUAT: bool = False
    DeployedToUATDate: date | None = None
    DeployedToUATBy: str | None = Field(default=None, max_length=10)
    UATApproved: bool = False
    UATApprovedDate: date | None = None
    UATApprovedBy: str | None = Field(default=None, max_length=10)
    UATSmokeTestsApproved: bool = False
    UATSmokeTestsApprovedDate: date | None = None
    UATSmokeTestsApprovedBy: str | None = Field(default=None, max_length=10)
    ReadyForProdDeployment: bool = False
    ReadyForProdDeploymentDate: date | None = None
    ReadyForProdDeploymentBy: str | None = Field(default=None, max_length=10)
    DeployedToProd: bool = False
    DeployedToProdDate: date | None = None
    DeployedToProdBy: str | None = Field(default=None, max_length=10)
    ProdSmokeTestsPassed: bool = False
    ProdSmokeTestsPassedDate: date | None = None
    ProdSmokeTestsPassedBy: str | None = Field(default=None, max_length=10)

    DataModeling: str | None = Field(default=None, max_length=200)
    Developer: str | None = Field(default=None, max_length=200)
    QAApproval: str | None = Field(default=None, max_length=200)
    UATApprover: str | None = Field(default=None, max_length=200)

    Notes: str | None = Field(default=None, max_length=4000)

    @field_validator(
        "PINumberRelease", "ReleaseWave", "Requestor", "Item", "Priority",
        "ComponentName", "ComponentType", "DataModeling", "Developer",
        "QAApproval", "UATApprover", "Notes",
    )
    @classmethod
    def _blank_to_null(cls, v: str | None) -> str | None:
        return _clean(v)


class Deployment(DeploymentIn):
    """A tracked component as returned to the UI."""

    DeploymentId: str
    CreatedBy: str | None = None
    CreatedDate: datetime | None = None
    LastModified: datetime | None = None
    LastModifiedBy: str | None = None


class DeploymentRequest(BaseModel):
    """Update payload. The id travels in the path."""

    values: DeploymentIn
    # The LastModified the client read. The server refuses the write if the row
    # has moved since. Omitting it is an explicit override; the UI always sends it.
    expected_last_modified: str | None = None


class GateRequest(BaseModel):
    """Set one gate, leaving the rest of the row untouched."""

    gate: str
    passed: bool
    # The day it was passed. The UI sends today when ticking; null records
    # "passed, day unknown". Ignored when `passed` is false.
    passedOn: date | None = None
    expected_last_modified: str | None = None


class ReleaseSummary(BaseModel):
    """One PI release in the picker."""

    release: str
    components: int
    deployed: int
    releaseDate: date | None = None


class ActivityRun(BaseModel):
    """One activity inside a pipeline run."""

    name: str
    type: str | None = None
    status: str | None = None
    errorCode: str | None = None
    message: str | None = None
    failureType: str | None = None
    start: datetime | None = None
    end: datetime | None = None


class LiveJobStatus(BaseModel):
    """Live job-instance status for a run the status table still shows as
    Running -- job level only; see FailureDetail for activity-level detail."""

    process: str
    runId: str
    pipelineName: str | None = None
    status: str | None = None
    startTimeUtc: datetime | None = None
    endTimeUtc: datetime | None = None


class FailureDetail(BaseModel):
    """Why a process's last run failed, from the Fabric API."""

    process: str
    runId: str
    pipelineName: str | None = None
    status: str | None = None
    startTimeUtc: datetime | None = None
    endTimeUtc: datetime | None = None
    # Job-level failureReason. Often much vaguer than the root cause below.
    errorCode: str | None = None
    message: str | None = None
    activities: list[ActivityRun] = []
    # The activity that actually explains the failure, with wrappers and explicit
    # Fail activities filtered out.
    rootCause: ActivityRun | None = None
    # Non-fatal problems worth showing (e.g. the run has aged out of Fabric).
    warnings: list[str] = []

    # Fallback for runs Fabric no longer retains: the message the orchestrator
    # logged at the time. Kept in separate fields, and labelled as such in the UI,
    # so logged text is never mistaken for live API detail.
    loggedMessage: str | None = None
    loggedAt: str | None = None
    loggedRunId: str | None = None


class ERDColumn(BaseModel):
    """A column in the Silver layer ERD."""

    column_name: str
    data_type: str
    is_primary_key: bool
    is_foreign_key: bool
    foreign_key_target: str | None = None
    nullable: bool


class ERDTable(BaseModel):
    """A table in the Silver layer ERD."""

    schema_name: str
    table_name: str
    short_name: str
    column_count: int
    description: str | None = None
    last_modified: datetime | None = None
    columns: list[ERDColumn]


class ERDRelationship(BaseModel):
    """A Foreign Key relationship in the Silver layer."""

    from_table: str
    from_column: str
    to_table: str
    to_column: str


class ERDResponse(BaseModel):
    """Complete ERD for the Silver layer."""

    tables: list[ERDTable]
    relationships: list[ERDRelationship]
    # Tables the spec maps but that do not exist in `env` yet, so were dropped.
    # Reported rather than silently omitted: "12 mapped tables are not in PRD"
    # is the interesting half of the answer.
    hidden: int = 0
    # Which environment the diagram was cut to; None means the whole spec.
    env: str | None = None
