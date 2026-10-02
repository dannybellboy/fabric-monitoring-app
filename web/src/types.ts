/**
 * Field names match the warehouse/Lakehouse columns exactly, including their
 * inconsistent casing (readyForUAT, isStoredPro, createdDate). Keeping them
 * identical means anyone who reads the table in Fabric recognises the UI, and
 * there is no mapping layer to get out of step.
 */

/** The 13 editable columns, as sent to POST/PUT. */
export interface RowInput {
  Process: string
  Dependency: string | null
  readyForUAT: boolean
  readyForProd: boolean
  isStoredPro: boolean
  RunTimes: string | null
  RequiresHashing: boolean
  isGold: boolean
  WarehouseName: string | null
  WorkspacePrefix: string | null
  NeedsTimestamp: boolean
  lookbackRequired: boolean
  isActive: boolean
}

/** A dependency-graph row as returned by the API. */
export interface Row extends RowInput {
  RowId: string
  LastModifiedDate: string | null
  CreatedBy: string | null
  createdDate: string | null
  ModifiedBy: string | null
}

/**
 * A dependency-graph edge read straight from one environment's own published
 * table (GET /api/graph), rather than DEV's editable table.
 * Same shape as RowInput -- there is no RowId because this is not editable.
 */
export type GraphRow = RowInput

export interface Identity {
  /** Which build is running — shown in the header for support questions. */
  version: string
  name: string
  username: string
  warehouse: string
  monitoringConfigured: boolean
  /** Whether this user holds the Fabric Admin role on the `adminEnv` workspace,
   *  which is what permits editing a dependency graph outside DEV. The server
   *  enforces this on every write regardless; it is here so the UI can explain
   *  the restriction rather than let someone fill in a form that will be refused. */
  isAdmin: boolean
  /** Label of the environment whose Admin role grants that, e.g. 'PRD'. */
  adminEnv: string
}

export interface Issue {
  level: 'error' | 'warning'
  message: string
  rowId: string | null
}

/** A row of ProcessExecutionStatus, enriched by the server. Read-only. */
export interface ProcessStatus {
  Process: string
  Status: string | null
  LastRunTime: string | null
  LastSuccess: string | null
  RunInstanceId: string | null
  LastCheckedTime: string | null
  RetryCount: number | null
  /** Differenced server-side: these timestamps are naive UTC, so a browser
   *  parsing them would treat them as local time and skew every age. */
  daysSinceSuccess: number | null
  hoursSinceRun: number | null
  /** False when the orchestrator's graph has no row for this process. */
  inGraph: boolean
  readyForUAT: boolean | null
  readyForProd: boolean | null
  isActive: boolean | null
}

// ---------------------------------------------------------------------------
// Source-to-target spec (HDX.Table_Metadata / HDX.Table_Columns)
// ---------------------------------------------------------------------------

export interface S2TTarget {
  target: string
  mappings: number
}

export interface S2TTableRef {
  table_name: string
  columns: number
  load_method: string | null
  workflow: string | null
  procedure_name: string | null
  last_modified: string | null
}

/** One source table feeding a mapped table, and how many columns come from it. */
export interface S2TSourceRef {
  table_name: string
  columns: number
}

/**
 * What one stored proc builds, from HDX.Table_Metadata. The dependency graph only
 * knows procedure names, so this is what lets the Lineage diagram label a
 * stored-proc node with the table it populates.
 *
 * One entry per layer the table is mapped in -- a few are mapped in both Gold and
 * PostgreSQL -- because each layer declares its own sources.
 */
export interface S2TProcedureTable {
  procedure_name: string
  table_name: string
  medallion_layer: string
  sources: S2TSourceRef[]
}

/** Editable metadata fields. The key (table_name + medallion_layer) is separate. */
export interface S2TMetadataIn {
  load_method: string | null
  procedure_name: string | null
  workflow: string | null
  base_table_logic: string | null
  join_logic: string | null
  filter_logic: string | null
  table_description: string | null
}

export interface S2TMetadata extends S2TMetadataIn {
  table_name: string
  medallion_layer: string
  last_modified: string | null
  last_modified_by: string | null
}

export interface S2TColumnIn {
  column_ordinal: number | null
  data_type: string | null
  not_null: boolean | null
  field_category: string | null
  transformation: string | null
  source_table_name: string | null
  source_column_name: string | null
  mapping_status: string | null
  dev_status: string | null
  change_requiring_update: boolean | null
  business_description: string | null
}

export interface S2TColumn extends S2TColumnIn {
  table_name: string
  column_name: string
  medallion_layer: string
  last_modified: string | null
  last_modified_by: string | null
}

/** Ambiguity in this mapping. Non-empty values block the matching writes. */
export interface S2TDuplicates {
  metadataRows: number
  duplicateColumns: { columnName: string; count: number }[]
}

export interface S2TMapping {
  metadata: S2TMetadata | null
  columns: S2TColumn[]
  duplicates: S2TDuplicates
}

/** Datalist values: canonical first, then variants already in the data. */
export type S2TSuggestions = Record<string, string[]>

/** One column's live shape in one environment. */
export interface S2TEnvColumn {
  access: 'ok' | 'no_access' | 'unavailable'
  present: boolean
  data_type: string | null
  not_null: boolean | null
  matches: boolean
}

export interface S2TValidationColumn {
  column_name: string
  mapped_data_type: string | null
  mapped_not_null: boolean | null
  environments: Record<string, S2TEnvColumn>
}

/** Result of comparing a mapping against each environment's live DDL. */
export interface S2TValidation {
  environments: string[]
  access: Record<string, 'ok' | 'no_access' | 'unavailable'>
  table_found: Record<string, boolean>
  columns: S2TValidationColumn[]
  matches: boolean
}

export const EMPTY_S2T_METADATA: S2TMetadataIn = {
  load_method: null,
  procedure_name: null,
  workflow: null,
  base_table_logic: null,
  join_logic: null,
  filter_logic: null,
  table_description: null,
}

export const EMPTY_S2T_COLUMN: S2TColumnIn = {
  column_ordinal: null,
  data_type: null,
  not_null: null,
  field_category: null,
  transformation: null,
  source_table_name: null,
  source_column_name: null,
  mapping_status: null,
  dev_status: null,
  change_requiring_update: null,
  business_description: null,
}

// ---------------------------------------------------------------------------
// Deployment tracker (deploy.DeploymentTracker)
// ---------------------------------------------------------------------------

/**
 * Editable fields of a tracked component.
 *
 * Each gate is a pair: `<Gate>` says whether it was passed, `<Gate>Date` says
 * when — null when the day is not known, which is the case for every row
 * imported from the spreadsheet, where only Y/N was ever recorded.
 *
 * Nothing is required. Most planned rows have an Item but no component name yet.
 */
export interface DeploymentInput {
  PINumberRelease: string | null
  /** The sheet's own Release column: a wave within the PI (1–15, or BACKLOG). */
  ReleaseWave: string | null
  ReleaseDate: string | null
  /** Who asked for the work — HDX, HFN, Finance. */
  Requestor: string | null
  Item: string | null
  Priority: string | null
  ComponentName: string | null
  ComponentType: string | null

  // <Gate>By: initials of whoever ticked it, stamped automatically from the
  // signed-in user -- never typed by hand, so there is no form field for it.
  DataModelingComplete: boolean
  DataModelingCompleteDate: string | null
  DataModelingCompleteBy: string | null
  ReadyForCodeReview: boolean
  ReadyForCodeReviewDate: string | null
  ReadyForCodeReviewBy: string | null
  CodeReviewApproved: boolean
  CodeReviewApprovedDate: string | null
  CodeReviewApprovedBy: string | null
  DeployedToQA: boolean
  DeployedToQADate: string | null
  DeployedToQABy: string | null
  QAApproved: boolean
  QAApprovedDate: string | null
  QAApprovedBy: string | null
  DeployedToUAT: boolean
  DeployedToUATDate: string | null
  DeployedToUATBy: string | null
  UATApproved: boolean
  UATApprovedDate: string | null
  UATApprovedBy: string | null
  UATSmokeTestsApproved: boolean
  UATSmokeTestsApprovedDate: string | null
  UATSmokeTestsApprovedBy: string | null
  ReadyForProdDeployment: boolean
  ReadyForProdDeploymentDate: string | null
  ReadyForProdDeploymentBy: string | null
  DeployedToProd: boolean
  DeployedToProdDate: string | null
  DeployedToProdBy: string | null
  ProdSmokeTestsPassed: boolean
  ProdSmokeTestsPassedDate: string | null
  ProdSmokeTestsPassedBy: string | null

  DataModeling: string | null
  Developer: string | null
  QAApproval: string | null
  UATApprover: string | null

  Notes: string | null
}

export interface Deployment extends DeploymentInput {
  DeploymentId: string
  CreatedBy: string | null
  CreatedDate: string | null
  /** Doubles as the row version: sent back on save so a stale write is refused. */
  LastModified: string | null
  LastModifiedBy: string | null
}

export interface ReleaseSummary {
  release: string
  components: number
  deployed: number
  releaseDate: string | null
}

/**
 * The ten tracked gates, in the order they are passed. The grid columns, the
 * progress bar and the stage summary all read this, so "how far along is it" has
 * one definition. `short` is the grid heading; the full label is its tooltip.
 *
 * `dateKey` is the companion column holding the day it was passed, which is null
 * on everything imported from the spreadsheet.
 *
 * `ProdSmokeTestsPassed` is deliberately absent: it is not a gate a component has
 * to clear to count as done. The column and its imported values still exist in
 * `deploy.DeploymentTracker` and are still returned by the API — they are just not
 * shown or counted. Re-adding a line here would bring it back.
 */
export const GATES = [
  { key: 'DataModelingComplete', dateKey: 'DataModelingCompleteDate', byKey: 'DataModelingCompleteBy', label: 'Data Modeling Complete', short: 'Model' },
  // "CR" is used day to day for other things here, so these two gates are named
  // for what they mean rather than abbreviated. The columns behind them are still
  // ReadyForCodeReview / CodeReviewApproved, matching the spreadsheet headers the
  // importer maps from.
  { key: 'ReadyForCodeReview', dateKey: 'ReadyForCodeReviewDate', byKey: 'ReadyForCodeReviewBy', label: 'Dev Complete', short: 'Dev Complete' },
  { key: 'CodeReviewApproved', dateKey: 'CodeReviewApprovedDate', byKey: 'CodeReviewApprovedBy', label: 'Code Approved', short: 'Code Approved' },
  { key: 'DeployedToQA', dateKey: 'DeployedToQADate', byKey: 'DeployedToQABy', label: 'Deployed to QA', short: 'QA Deploy' },
  { key: 'QAApproved', dateKey: 'QAApprovedDate', byKey: 'QAApprovedBy', label: 'QA Approved', short: 'QA Apv' },
  { key: 'DeployedToUAT', dateKey: 'DeployedToUATDate', byKey: 'DeployedToUATBy', label: 'Deployed to UAT', short: 'UAT Deploy' },
  { key: 'UATApproved', dateKey: 'UATApprovedDate', byKey: 'UATApprovedBy', label: 'UAT Approved', short: 'UAT Apv' },
  { key: 'UATSmokeTestsApproved', dateKey: 'UATSmokeTestsApprovedDate', byKey: 'UATSmokeTestsApprovedBy', label: 'UAT Smoke Tests Approved', short: 'UAT smoke' },
  { key: 'ReadyForProdDeployment', dateKey: 'ReadyForProdDeploymentDate', byKey: 'ReadyForProdDeploymentBy', label: 'Ready for Prod Deployment', short: 'Prod ready' },
  { key: 'DeployedToProd', dateKey: 'DeployedToProdDate', byKey: 'DeployedToProdBy', label: 'Deployed to Prod', short: 'PROD' },
] as const satisfies readonly {
  key: keyof DeploymentInput
  dateKey: keyof DeploymentInput
  byKey: keyof DeploymentInput
  label: string
  short: string
}[]

export type GateKey = (typeof GATES)[number]['key']

/** Owner columns, which share one pooled suggestion list of names. */
export const OWNERS = [
  { key: 'DataModeling', label: 'Data Modeling' },
  { key: 'Developer', label: 'Developer' },
  { key: 'QAApproval', label: 'QA Approval' },
  { key: 'UATApprover', label: 'UAT Approver' },
] as const satisfies readonly { key: keyof DeploymentInput; label: string }[]

/**
 * Owner columns shown in the grid. Data Modeling and Developer are still
 * tracked — still editable in the form, still part of the search — just not
 * given their own columns; QA Approval and UAT Approver are what people scan
 * for day to day.
 */
export const TABLE_OWNERS = OWNERS.filter(
  (o) => o.key !== 'DataModeling' && o.key !== 'Developer',
)

/**
 * The closed set of component types new work is classified into. Unlike
 * Priority or the owner fields, this is a real dropdown, not a suggestion —
 * the taxonomy is deliberately fixed. Historical rows imported from the
 * spreadsheet carry 79+ free-text variants that predate this list; the form
 * shows a row's existing value alongside these options rather than discarding
 * it, so opening an old row for an unrelated edit can never silently reset it.
 */
export const COMPONENT_TYPES = [
  'Silver Table DDL (New Table)',
  'Gold Table DDL (New Table)',
  'Silver Table DDL (Update)',
  'Gold Table DDL (Update)',
  'Silver Stored Procedure (New)',
  'Gold Stored Procedure (New)',
  'Silver Stored Procedure (Update)',
  'Gold Stored Procedure (Update)',
  'Bronze Ingestion Pipeline',
  'Fivetran Ingestion',
  'Export Pipeline',
  'Bronze Ingestion Pipeline (Update)',
  'Fivetran Ingestion (Update)',
  'Export Pipeline (Update)',
  'Pipeline (General)',
  'Schedule Change',
  'Truncate and Reload',
  'Variable Library Changes'
] as const

const NO_GATES = Object.fromEntries(
  GATES.flatMap((gate) => [
    [gate.key, false],
    [gate.dateKey, null],
    [gate.byKey, null],
  ]),
) as Pick<DeploymentInput, GateKey | (typeof GATES)[number]['dateKey' | 'byKey']>

export const EMPTY_DEPLOYMENT: DeploymentInput = {
  PINumberRelease: null,
  ReleaseWave: null,
  ReleaseDate: null,
  Requestor: null,
  Item: null,
  Priority: null,
  ComponentName: null,
  ComponentType: null,
  ...NO_GATES,
  // Not in GATES, so not covered by NO_GATES — see the note there.
  ProdSmokeTestsPassed: false,
  ProdSmokeTestsPassedDate: null,
  ProdSmokeTestsPassedBy: null,
  DataModeling: null,
  Developer: null,
  QAApproval: null,
  UATApprover: null,
  Notes: null,
}

/** In-progress interactive sign-in, polled while it completes. */
export interface SignInProgress {
  state: 'idle' | 'pending' | 'ok' | 'failed'
  method: 'browser' | 'device' | null
  deviceCode: { url: string; code: string; expiresAt: string | null } | null
  error: string | null
}

export interface AuthStatus {
  signedIn: boolean
  name: string | null
  username: string | null
  reason?: string
  signIn: SignInProgress
}

export interface PreflightCheck {
  name: string
  status: 'ok' | 'fail' | 'warn' | 'skip'
  detail: string
  fix: string | null
}

export interface PreflightReport {
  ok: boolean
  blocked: boolean
  checks: PreflightCheck[]
}

/** An environment the Health tab can read. */
export interface EnvironmentInfo {
  key: string
  label: string
  /** False until its workspace id and SQL endpoint are configured. */
  configured: boolean
  /** The column NB_Orchestrator gates on here; null for DEV and QA. */
  promotionColumn: string | null
  /** Whether this environment's dependency graph can be edited at all: its table
   *  has to accept DML, which rules out an environment still reading a lakehouse
   *  copy. Says nothing about the caller -- editing anywhere but DEV
   *  additionally needs Identity.isAdmin. */
  editable: boolean
  /** Whether this environment's ProcessExecutionStatus table can be written at
   *  all -- false where it is a read-only lakehouse copy. Like `editable`, this
   *  describes the table, not the caller: resetting a retry count outside DEV
   *  also needs Identity.isAdmin. */
  statusWritable: boolean
}

/** Why an environment could not be compared, or 'ok' if it was. */
export type GraphDiffAccess = 'ok' | 'no_access' | 'unavailable' | 'unreadable'

export type GraphDiffValue = string | number | boolean | null

/** One environment in a pairwise comparison. */
export interface GraphDiffSide {
  key: string
  label: string
  access: GraphDiffAccess
  rowCount: number
  /** Rows sharing a (Process, Dependency) with an earlier row; only the first
   *  is compared. Non-zero is possible because Fabric enforces no uniqueness. */
  duplicates: number
  /** Which comparable columns this environment's table actually has. */
  columns: string[]
}

/** An edge that exists on one side of the comparison and not the other. */
export interface GraphDiffOnlyIn {
  process: string
  dependency: string | null
  /** Which side has it. */
  env: 'left' | 'right'
}

/**
 * One column of one edge that the two environments disagree about. Flat, one
 * per (edge, column), because that is exactly one row of the differences table.
 */
export interface GraphDiffDifference {
  process: string
  dependency: string | null
  field: string
  left: GraphDiffValue
  right: GraphDiffValue
}

/** Outcome of copying one edge from one environment to another. */
export interface GraphApplyResult {
  process: string
  dependency: string | null
  source: string
  target: string
  /** 'unchanged' when the two already agreed — possible if the comparison was
   *  stale by the time the copy ran. */
  action: 'created' | 'updated' | 'unchanged'
  /** Columns actually written; empty for 'created' and 'unchanged'. */
  changed: string[]
}

/**
 * Pairwise comparison of two environments' dependency-graph table contents
 * (GET /api/graph/diff?left=&right=). A data diff, not a DDL one, matched on
 * (Process, Dependency) because RowId differs per environment.
 *
 * Two environments rather than all four: comparing everything at once made an
 * edge present in only one environment show every column as trivially agreeing,
 * left three-way disagreements with no "right" answer to highlight against, and
 * did not fit on screen.
 */
export interface GraphDiff {
  left: GraphDiffSide
  right: GraphDiffSide
  /** False when either side could not be read; the lists are then empty because
   *  there is nothing to say, which must not be read as "they agree". */
  comparable: boolean
  /** Columns both tables have; one present on a single side is a schema
   *  difference, and this view is about data. */
  sharedColumns: string[]
  /** Distinct edges across both sides. */
  compared: number
  /** Edges both sides have, agreeing on every shared column. */
  identical: number
  onlyIn: GraphDiffOnlyIn[]
  differences: GraphDiffDifference[]
}

export interface StatusReport {
  /** Which environment this report describes. */
  env: string
  rows: ProcessStatus[]
  /** In the graph but never tracked — no status row exists. */
  untracked: string[]
  generatedAt: string
}

/** One activity inside a pipeline run. */
export interface ActivityRun {
  name: string
  type: string | null
  status: string | null
  errorCode: string | null
  message: string | null
  failureType: string | null
  start: string | null
  end: string | null
}

/** Live job-instance status, from the Fabric API, for a row still showing as
 *  Running in the status table. Job level only -- see FailureDetail for
 *  activity-level detail once the table itself flags a row Failed. */
export interface LiveJobStatus {
  process: string
  runId: string
  pipelineName: string | null
  status: string | null
  startTimeUtc: string | null
  endTimeUtc: string | null
}

/** Why a process's last run failed, from the Fabric API. */
export interface FailureDetail {
  process: string
  runId: string
  pipelineName: string | null
  status: string | null
  startTimeUtc: string | null
  endTimeUtc: string | null
  /** Job-level failureReason — usually vaguer than rootCause. */
  errorCode: string | null
  message: string | null
  activities: ActivityRun[]
  /** The activity that actually explains the failure. */
  rootCause: ActivityRun | null
  warnings: string[]
  /** Fallback for runs Fabric no longer retains — kept separate so the UI can
   *  label it as coming from the orchestrator's log, not the live API. */
  loggedMessage: string | null
  loggedAt: string | null
  loggedRunId: string | null
}

export const BOOLEAN_FIELDS = [
  'readyForUAT',
  'readyForProd',
  'isStoredPro',
  'RequiresHashing',
  'isGold',
  'NeedsTimestamp',
  'lookbackRequired',
  'isActive',
] as const satisfies readonly (keyof RowInput)[]

export const EMPTY_ROW: RowInput = {
  Process: '',
  Dependency: null,
  readyForUAT: false,
  readyForProd: false,
  isStoredPro: false,
  RunTimes: '9',
  RequiresHashing: false,
  isGold: false,
  WarehouseName: null,
  // Every existing row uses this prefix, so it is the sensible default rather
  // than something each person has to retype.
  WorkspacePrefix: 'WS_HDX_DE_',
  NeedsTimestamp: false,
  lookbackRequired: false,
  isActive: true,
}

// ---------------------------------------------------------------------------
// Silver Layer ERD (Entity-Relationship Diagram)
// ---------------------------------------------------------------------------

export interface ERDColumn {
  column_name: string
  data_type: string
  is_primary_key: boolean
  is_foreign_key: boolean
  foreign_key_target: string | null
  nullable: boolean
}

export interface ERDTable {
  schema_name: string
  table_name: string
  short_name: string
  description: string | null
  column_count: number
  last_modified: string | null
  columns: ERDColumn[]
}

export interface ERDRelationship {
  from_table: string
  from_column: string
  to_table: string
  to_column: string
}

export interface ERDData {
  tables: ERDTable[]
  relationships: ERDRelationship[]
  /** Mapped tables dropped because they do not exist in `env` yet. */
  hidden: number
  /** Which environment the diagram was cut to; null means the whole spec. */
  env: string | null
}
