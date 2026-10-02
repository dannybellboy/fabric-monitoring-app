-- ============================================================================
-- dg_tool: add deploy.DeploymentTracker.Requestor.
--
-- Target: WH_HDX_DE_Silver (Fabric Warehouse, supports DML)
--
-- Who asked for the work -- HDX, HFN, Finance. The release spreadsheet has
-- carried this column since PI 27.3; the table did not, so it had nowhere to
-- land until now.
--
-- ADDITIVE ONLY: adds one nullable column. It never drops or rewrites
-- anything, and it is safe to re-run -- the ALTER is skipped when the column
-- already exists. No backfill: rows predating the column genuinely have no
-- requestor on record, and inventing one would be worse than leaving it NULL.
--
-- Guarded with INFORMATION_SCHEMA.COLUMNS rather than COL_LENGTH -- see the
-- note in 07_add_gate_signoff_by_columns.sql for why.
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'Requestor')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD Requestor varchar(50) NULL');
GO
