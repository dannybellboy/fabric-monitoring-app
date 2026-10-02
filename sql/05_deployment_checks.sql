-- ============================================================================
-- dg_tool: integrity checks for the deployment tracker.
--
-- Fabric Warehouse does not enforce uniqueness, so run this after an import or
-- if you suspect something wrote to deploy.DeploymentTracker outside the app.
-- Every query below should return zero rows.
-- ============================================================================

-- 1. Duplicate DeploymentId (surrogate key must be unique).
SELECT DeploymentId, COUNT(*) AS n
FROM deploy.DeploymentTracker
GROUP BY DeploymentId
HAVING COUNT(*) > 1;

-- 2. Duplicate natural key. The app refuses to create one, and a duplicate here
--    makes BOTH rows uneditable -- an update cannot tell which row it addresses,
--    so it refuses rather than guess.
SELECT LOWER(LTRIM(RTRIM(ISNULL(PINumberRelease, '')))) AS pi_key,
       LOWER(LTRIM(RTRIM(ISNULL(ReleaseWave, ''))))     AS wave_key,
       LOWER(LTRIM(RTRIM(ISNULL(Item, ''))))            AS item_key,
       LOWER(LTRIM(RTRIM(ISNULL(ComponentName, ''))))   AS component_key,
       LOWER(LTRIM(RTRIM(ISNULL(ComponentType, ''))))   AS type_key,
       COUNT(*) AS n
FROM deploy.DeploymentTracker
GROUP BY LOWER(LTRIM(RTRIM(ISNULL(PINumberRelease, '')))),
         LOWER(LTRIM(RTRIM(ISNULL(ReleaseWave, '')))),
         LOWER(LTRIM(RTRIM(ISNULL(Item, '')))),
         LOWER(LTRIM(RTRIM(ISNULL(ComponentName, '')))),
         LOWER(LTRIM(RTRIM(ISNULL(ComponentType, ''))))
HAVING COUNT(*) > 1;

-- 3. Rows with no name at all. Neither field is required on its own -- planned
--    work often has only an Item -- but a row with neither cannot be found again.
SELECT DeploymentId, PINumberRelease, ReleaseWave
FROM deploy.DeploymentTracker
WHERE (ComponentName IS NULL OR LTRIM(RTRIM(ComponentName)) = '')
  AND (Item IS NULL OR LTRIM(RTRIM(Item)) = '');

-- 4. A gate date without the gate. The app clears the date when a gate is
--    unticked, so this combination claims a gate was passed on a day it was not.
SELECT DeploymentId, ComponentName, Item
FROM deploy.DeploymentTracker
WHERE (DataModelingComplete   = 0 AND DataModelingCompleteDate   IS NOT NULL)
   OR (ReadyForCodeReview     = 0 AND ReadyForCodeReviewDate     IS NOT NULL)
   OR (CodeReviewApproved     = 0 AND CodeReviewApprovedDate     IS NOT NULL)
   OR (DeployedToQA           = 0 AND DeployedToQADate           IS NOT NULL)
   OR (QAApproved             = 0 AND QAApprovedDate             IS NOT NULL)
   OR (DeployedToUAT          = 0 AND DeployedToUATDate          IS NOT NULL)
   OR (UATApproved            = 0 AND UATApprovedDate            IS NOT NULL)
   OR (UATSmokeTestsApproved  = 0 AND UATSmokeTestsApprovedDate  IS NOT NULL)
   OR (ReadyForProdDeployment = 0 AND ReadyForProdDeploymentDate IS NOT NULL)
   OR (DeployedToProd         = 0 AND DeployedToProdDate         IS NOT NULL)
   OR (ProdSmokeTestsPassed   = 0 AND ProdSmokeTestsPassedDate   IS NOT NULL);

-- 5. Gates dated out of order. The app does not block this (a component can
--    legitimately be re-deployed to QA after a UAT failure, leaving the dates
--    looking backwards), but a gate dated before the one it depends on is worth
--    a look -- it is usually a typo in a hand-entered date. Rows imported from
--    the spreadsheet have no gate dates, so they never appear here.
SELECT DeploymentId, ComponentName, Item,
       ReadyForCodeReviewDate, CodeReviewApprovedDate,
       DeployedToQADate, QAApprovedDate, DeployedToUATDate, UATApprovedDate,
       UATSmokeTestsApprovedDate, ReadyForProdDeploymentDate, DeployedToProdDate
FROM deploy.DeploymentTracker
WHERE CodeReviewApprovedDate    < ReadyForCodeReviewDate
   OR QAApprovedDate            < DeployedToQADate
   OR UATApprovedDate           < DeployedToUATDate
   OR UATSmokeTestsApprovedDate < UATApprovedDate
   OR DeployedToProdDate        < ReadyForProdDeploymentDate;

-- 6. Deployed to Prod without UAT sign-off. Not illegal -- hotfixes happen --
--    but every row here should have a reason someone can state.
SELECT DeploymentId, PINumberRelease, ReleaseWave, ComponentName, Item
FROM deploy.DeploymentTracker
WHERE DeployedToProd = 1
  AND (UATApproved = 0 OR UATSmokeTestsApproved = 0);
