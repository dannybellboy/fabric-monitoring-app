-- ============================================================================
-- dg_tool: add orch.dependencygraph.lookbackRequired.
--
-- Target: WH_HDX_DE_Silver (Fabric Warehouse, supports DML)
--
-- The flag the Dependency Graph tab's "Lookback required" checkbox writes.
-- Run this once against any warehouse whose orch.dependencygraph predates the
-- column; sql/01_create_graph_table.sql already includes it for fresh installs.
--
-- ADDITIVE ONLY: adds one nullable column and backfills it. It never drops or
-- rewrites anything, and it is safe to re-run -- the ALTER is skipped when the
-- column exists, and the backfill only touches rows still NULL.
--
-- The column is nullable because Fabric Warehouse supports neither DEFAULT
-- constraints nor adding a NOT NULL column to a table that already has rows.
-- The backfill below gives every existing row an explicit 0, the app always
-- writes the column, and queries.py reads it through ISNULL -- so nothing
-- downstream ever sees a NULL.
-- ============================================================================

IF COL_LENGTH('orch.dependencygraph', 'lookbackRequired') IS NULL
EXEC('ALTER TABLE orch.dependencygraph ADD lookbackRequired bit NULL');
GO

UPDATE orch.dependencygraph
SET    lookbackRequired = 0
WHERE  lookbackRequired IS NULL;
GO

-- Should return 0.
SELECT COUNT(*) AS rows_still_null
FROM   orch.dependencygraph
WHERE  lookbackRequired IS NULL;
GO
