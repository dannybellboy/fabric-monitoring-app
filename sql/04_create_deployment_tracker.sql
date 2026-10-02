-- ============================================================================
-- dg_tool: deployment tracker, replacing the hand-maintained release
-- spreadsheet (HDX Deployment Tracker.xlsx, sheets PI27.2 and PI27.3).
--
-- Target: WH_HDX_DE_Silver (Fabric Warehouse, supports DML)
--
-- Why this table lives in the warehouse:
--   Unlike dependencygraph, nothing outside dg_tool reads or writes this table,
--   and no orchestrator consumes it -- so there is no reason for a staging copy
--   or a publish step. The warehouse accepts DML, so the app edits it directly
--   and a save takes effect immediately.
--
-- Each of the eleven gates is TWO columns: a bit saying whether it was passed,
-- and a nullable date saying when. That pairing exists because the spreadsheet
-- this table replaces recorded only Y/N -- so for every imported row the gate is
-- known to have passed but the day is genuinely unknowable. Collapsing the two
-- into one date column would force a choice between inventing a date and
-- throwing the fact away. Gates ticked in the app from now on set both, so
-- cycle-time reporting works going forward without backdating history.
--
-- CREATE-ONLY: this script only adds new objects. It never alters or drops
-- anything that already exists, and it is safe to re-run.
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'deploy')
    EXEC('CREATE SCHEMA deploy');
GO

IF OBJECT_ID('deploy.DeploymentTracker', 'U') IS NULL
EXEC('
CREATE TABLE deploy.DeploymentTracker (
    -- Surrogate key, a uuid4 minted by the app and never changed. The natural
    -- key (PI + wave + Item + Component) is what people recognise, but any part
    -- of it can be corrected after the fact, which would orphan the row.
    DeploymentId           varchar(64)   NOT NULL,

    -- What is being released. PINumberRelease is the PI ("PI 27.2", the
    -- spreadsheet tab); ReleaseWave is the sheet''s own Release column, a wave
    -- number within that PI (1..15, or BACKLOG). The two together are needed to
    -- tell rows apart: the same component ships in several waves of one PI.
    PINumberRelease        varchar(50)   NULL,
    ReleaseWave            varchar(20)   NULL,
    ReleaseDate            date          NULL,
    -- Who asked for the work -- HDX, HFN, Finance.
    Requestor              varchar(50)   NULL,
    Item                   varchar(400)  NULL,
    Priority               varchar(20)   NULL,
    -- Nullable: on planned work the component is often not identified yet (65 of
    -- 73 PI27.3 rows). The UI falls back to showing Item as the row label.
    ComponentName          varchar(400)  NULL,
    ComponentType          varchar(400)  NULL,

    -- The eleven gates, in the order they are passed.
    -- <Gate>     : 1 = passed, 0 = not passed.
    -- <Gate>Date : the day it was passed, or NULL if that day is not known
    --              (which is the case for every row imported from the sheet).
    -- <Gate>By   : initials of whoever ticked it, stamped automatically from
    --              the signed-in user -- NULL wherever that is not known,
    --              same as the date.
    DataModelingComplete       bit  NOT NULL,
    DataModelingCompleteDate   date NULL,
    DataModelingCompleteBy     varchar(10) NULL,
    ReadyForCodeReview         bit  NOT NULL,
    ReadyForCodeReviewDate     date NULL,
    ReadyForCodeReviewBy       varchar(10) NULL,
    CodeReviewApproved         bit  NOT NULL,
    CodeReviewApprovedDate     date NULL,
    CodeReviewApprovedBy       varchar(10) NULL,
    DeployedToQA               bit  NOT NULL,
    DeployedToQADate           date NULL,
    DeployedToQABy             varchar(10) NULL,
    QAApproved                 bit  NOT NULL,
    QAApprovedDate             date NULL,
    QAApprovedBy               varchar(10) NULL,
    DeployedToUAT              bit  NOT NULL,
    DeployedToUATDate          date NULL,
    DeployedToUATBy            varchar(10) NULL,
    UATApproved                bit  NOT NULL,
    UATApprovedDate            date NULL,
    UATApprovedBy              varchar(10) NULL,
    UATSmokeTestsApproved      bit  NOT NULL,
    UATSmokeTestsApprovedDate  date NULL,
    UATSmokeTestsApprovedBy    varchar(10) NULL,
    ReadyForProdDeployment     bit  NOT NULL,
    ReadyForProdDeploymentDate date NULL,
    ReadyForProdDeploymentBy   varchar(10) NULL,
    DeployedToProd             bit  NOT NULL,
    DeployedToProdDate         date NULL,
    DeployedToProdBy           varchar(10) NULL,
    ProdSmokeTestsPassed       bit  NOT NULL,
    ProdSmokeTestsPassedDate   date NULL,
    ProdSmokeTestsPassedBy     varchar(10) NULL,

    -- Who owns each part of it. Free text, matching the spreadsheet these rows
    -- come from; the UI suggests names already used rather than enforcing a list.
    DataModeling           varchar(200)  NULL,
    Developer              varchar(200)  NULL,
    QAApproval             varchar(200)  NULL,
    UATApprover            varchar(200)  NULL,

    Notes                  varchar(4000) NULL,

    -- Audit. LastModified doubles as the optimistic-concurrency version: an
    -- update sends the value it read, and the server refuses the write if the
    -- row has moved since.
    CreatedBy              varchar(200)  NULL,
    CreatedDate            datetime2(6)  NULL,
    LastModified           datetime2(6)  NULL,
    LastModifiedBy         varchar(200)  NULL
)
');
GO

-- Fabric Warehouse does not enforce PRIMARY KEY / UNIQUE constraints, so
-- uniqueness of DeploymentId and of (PINumberRelease, ReleaseWave, Item,
-- ComponentName, ComponentType) is enforced by the app (server/deployments.py)
-- and verifiable with sql/05_deployment_checks.sql.
--
-- ComponentType is in that key because it is what tells two rows apart when the
-- same component is changed twice in one wave for different reasons -- PI27.2
-- tracks SP_Create_GC_Item_Prosthetic_Sheaths once for "units per package" and
-- once for "unit of measure".
