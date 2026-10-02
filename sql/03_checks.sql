-- ============================================================================
-- dg_tool: integrity checks for the dependency graph.
--
-- Fabric Warehouse does not enforce uniqueness, so run this after a bulk edit
-- or if you suspect something wrote to orch.dependencygraph outside the app.
-- Every query below should return zero rows.
-- ============================================================================

-- 1. Duplicate RowId (surrogate key must be unique).
SELECT RowId, COUNT(*) AS n
FROM orch.dependencygraph
GROUP BY RowId
HAVING COUNT(*) > 1;

-- 2. Duplicate natural key. The app matches on this pair (case-insensitive,
--    trimmed), so a duplicate here means editing that pair is ambiguous.
SELECT LOWER(LTRIM(RTRIM(Process))) AS process_key,
       LOWER(LTRIM(RTRIM(ISNULL(Dependency, '')))) AS dependency_key,
       COUNT(*) AS n
FROM orch.dependencygraph
GROUP BY LOWER(LTRIM(RTRIM(Process))), LOWER(LTRIM(RTRIM(ISNULL(Dependency, ''))))
HAVING COUNT(*) > 1;

-- 3. Self-dependency (a process that depends on itself is a trivial cycle).
SELECT RowId, Process, Dependency
FROM orch.dependencygraph
WHERE LOWER(LTRIM(RTRIM(Process))) = LOWER(LTRIM(RTRIM(Dependency)));

-- 4. Blank Process.
SELECT RowId, Process
FROM orch.dependencygraph
WHERE Process IS NULL OR LTRIM(RTRIM(Process)) = '';

-- 5. Stored procs with no warehouse to run in. The orchestrator needs
--    WarehouseName to route a stored-proc call, so this combination is broken.
SELECT RowId, Process, Dependency, isStoredPro, WarehouseName
FROM orch.dependencygraph
WHERE isStoredPro = 1 AND (WarehouseName IS NULL OR LTRIM(RTRIM(WarehouseName)) = '');
