-- ============================================================================
-- dg_tool: the orchestrator dependency graph.
--
-- Target: WH_HDX_DE_Silver (Fabric Warehouse, supports DML)
--
-- orch.dependencygraph is both what NB_Orchestrator_WH reads to decide what to
-- run, and what the Dependency Graph tab edits directly -- ordinary T-SQL,
-- no staging copy, no publish step. Each environment (DEV, QA, UAT, PRD) now
-- has its own orch.dependencygraph in its own warehouse; this script targets
-- DEV's and is run per environment to create the others' copies.
--
-- CREATE-ONLY: this script only adds new objects. It never alters or drops
-- anything that already exists, and it is safe to re-run.
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'orch')
    EXEC('CREATE SCHEMA orch');
GO

IF OBJECT_ID('orch.dependencygraph', 'U') IS NULL
EXEC('
CREATE TABLE orch.dependencygraph (
    -- Surrogate key. The natural key (Process, Dependency) is what identifies
    -- a row conceptually, but it cannot address a row in the UI: Dependency
    -- is nullable, and editing either key column would otherwise orphan the
    -- row. RowId is a uuid4 minted by the app and never changes.
    RowId            varchar(64)  NOT NULL,

    -- The 13 business columns.
    Process          varchar(200) NOT NULL,
    Dependency       varchar(200) NULL,
    readyForUAT      bit          NOT NULL,
    readyForProd     bit          NOT NULL,
    isStoredPro      bit          NOT NULL,
    RunTimes         varchar(100) NULL,
    RequiresHashing  bit          NOT NULL,
    isGold           bit          NOT NULL,
    WarehouseName    varchar(200) NULL,
    WorkspacePrefix  varchar(100) NULL,
    NeedsTimestamp   bit          NOT NULL,
    -- Nullable, unlike every other flag, so that a table created here has the
    -- same shape as one migrated by sql/06_add_lookback_column.sql: Fabric
    -- Warehouse supports neither DEFAULT constraints nor adding a NOT NULL
    -- column to a table that already has rows. The app always writes it
    -- explicitly, and queries.py reads it through ISNULL.
    lookbackRequired bit          NULL,
    isActive         bit          NOT NULL,

    -- Audit columns.
    LastModifiedDate datetime2(6) NULL,
    CreatedBy        varchar(200) NULL,
    createdDate      datetime2(6) NULL,
    ModifiedBy       varchar(200) NULL
)
');
GO

-- Fabric Warehouse does not enforce PRIMARY KEY / UNIQUE constraints, so
-- uniqueness of RowId and of (Process, Dependency) is enforced by the app
-- (server/queries.py) and verifiable with sql/03_checks.sql.
