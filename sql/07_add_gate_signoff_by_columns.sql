-- ============================================================================
-- dg_tool: add "who passed it" columns to deploy.DeploymentTracker.
--
-- Target: WH_HDX_DE_Silver (Fabric Warehouse, supports DML)
--
-- Each of the eleven gates already has a bit (passed?) and a date (when?).
-- This adds a third column per gate, <Gate>By, holding the initials of whoever
-- ticked it -- stamped automatically by the app the same way the date is,
-- from the signed-in user, never typed by hand.
--
-- ADDITIVE ONLY: adds eleven nullable columns. It never drops or rewrites
-- anything, and it is safe to re-run -- each ALTER is skipped when its column
-- already exists. No backfill: who passed a gate before this column existed
-- is genuinely unknown, same as the date is for every row imported from the
-- spreadsheet, so existing rows are left NULL rather than guessed at.
--
-- Guarded with INFORMATION_SCHEMA.COLUMNS rather than COL_LENGTH: this
-- warehouse's engine rejects COL_LENGTH ("FUNCTION 'COL_LENGTH' is not
-- supported", error 15871) over at least one ODBC path, while
-- INFORMATION_SCHEMA is the technique server/deployments.py already relies on
-- (table_exists()) and is known to work here.
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'DataModelingCompleteBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD DataModelingCompleteBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'ReadyForCodeReviewBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD ReadyForCodeReviewBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'CodeReviewApprovedBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD CodeReviewApprovedBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'DeployedToQABy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD DeployedToQABy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'QAApprovedBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD QAApprovedBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'DeployedToUATBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD DeployedToUATBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'UATApprovedBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD UATApprovedBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'UATSmokeTestsApprovedBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD UATSmokeTestsApprovedBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'ReadyForProdDeploymentBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD ReadyForProdDeploymentBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'DeployedToProdBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD DeployedToProdBy varchar(10) NULL');
GO

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = 'deploy' AND TABLE_NAME = 'DeploymentTracker'
                 AND COLUMN_NAME = 'ProdSmokeTestsPassedBy')
EXEC('ALTER TABLE deploy.DeploymentTracker ADD ProdSmokeTestsPassedBy varchar(10) NULL');
GO
