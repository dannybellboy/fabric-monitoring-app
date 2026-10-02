# dg_tool — dependency graph CRUD

A local web app for reading and editing the orchestrator dependency graph, replacing
the hand-edited `data = [Row(...), ...]` list in
[NB_Create_Orch_LH_Resources.ipynb](../Fabric_Resources/NB_Create_Orch_LH_Resources.ipynb).

You sign in with your Azure credentials, search and filter 192 rows, create and edit
processes in a form that explains what each flag does, and deactivate rows without
touching a notebook.

---

## Tabs

| Tab | What it does | Writes? |
| --- | --- | --- |
| **S2T** | The source-to-target spec in `WH_HDX_DE_Silver.HDX` | **yes — live warehouse DML** |
| **Dependency Graph** | CRUD over the orchestrator's `dependencygraph` | **yes — live warehouse DML** |
| **Deployments** | Release tracker: components and their eleven gates | **yes — live warehouse DML** |
| **Lineage** | Navigable diagram of the dependency graph | no |
| **Health** | Execution status per environment | only "reset retry count", DEV only |

## The S2T tab

Two tables in `WH_HDX_DE_Silver.HDX` drive table and stored-proc generation:

* `Table_Metadata` — one row per (table_name, medallion_layer): load method, procedure
  name, workflow, and the base-table / join / filter SQL. 189 rows.
* `Table_Columns` — one row per (table_name, column_name, medallion_layer): data type,
  transformation, source mapping, and mapping/dev status. ~5,220 rows.

Pick a **Target** (Silver / Gold / PostgreSQL) then a **Table**, and you get the
metadata form above an editable column grid. Long SQL fields get monospace textareas
with a character count; the grid edits inline, marks changed rows with an accent bar,
and saves them in one action. Columns can be added, renamed, and deleted.

**Like every other tab, this writes directly to the live warehouse.** `HDX.*` sits in
a warehouse rather than a lakehouse, so DML works — there is no staging copy and no
publish step, and a save takes effect immediately.

### Neither table has a surrogate key

Rows are therefore addressed by natural key, and that key **is not unique in the
current data**. Three collisions exist:

* `Item.Images` / Silver — two `Table_Metadata` rows
* `SCM.SCM_Item_Relationship.child_publish_to_configurator` / Silver
* `Order.Oracle_Order_Header.data_source_system` / Silver

Adding an id column would mean altering a table other tooling reads, so instead
**every write counts the rows its key matches and refuses unless exactly one does**.
An ambiguous key returns 409 with the count, and the UI disables editing for it, rather
than silently updating one of two identical-looking rows. Resolve the duplicate
directly and editing starts working with no code change.

### Concurrent edits cannot clobber each other

`HDX.*` is shared — colleagues and `HDX_Integration` write it constantly
(`Table_Columns` grew from 5,219 to 5,229 rows in a single afternoon). An update here
rewrites every field of the row, so a stale read followed by a save would silently
overwrite whatever someone else changed in between.

Every save therefore sends back the `last_modified` it read, and **the server refuses
the write if the row has moved**, returning `412` naming who changed it and when:

> `AP.3P_Invoice_Lines / Silver was changed by jsmith@example.com at 2026-08-14T14:18:31,
> after you loaded it. Your save was not applied — reload to see their change, then redo
> yours.`

The UI shows that as a persistent banner with a Reload button rather than a toast,
because it needs a decision. Deletes are guarded the same way. Omitting the version is
an explicit override, which keeps scripted use possible; the UI always sends it.

### Staying current

* **Refresh** re-reads the table list and the open mapping.
* The mapping is also re-read **when the window regains focus** — but never while you
  have unsaved edits, since replacing a draft with server state would destroy work. In
  that case it flags that the view may be behind, and the version check above is what
  actually protects the data.

### Values are suggested, not enforced

`load_method`, `field_category`, `mapping_status` and `dev_status` are offered as
datalists — canonical values first, then the variants already in the data
(`Truncate and Reload` / `truncate and reload`, `Primary Key` / `Primary key`,
`Done` / `Complete`). They are suggestions rather than a closed dropdown on purpose:
silently rewriting someone else's value while editing an unrelated field on the same
row would be worse than tolerating the variants. New writes normalise blank to NULL,
so "unset" converges on one representation without rewriting history.

### Data problems it surfaces rather than hides

* **8 table/layer groups have columns but no metadata row**, so they are invisible to a
  picker built on `Table_Metadata` — including `Order.Oracle_Order_Fulfill_Line` with 67
  columns, and `Coding.HCPCS_Desciprtions` (note the misspelling). The tab lists these
  under "have columns but no metadata row"; clicking one pre-fills a create form so the
  orphaned columns get adopted.
* **6 `Order.*` metadata rows have no columns**, and still appear in the picker so they
  can be filled in.
* **6 `Table_Columns` rows have a data type in `medallion_layer`** — `location_id` and
  `provider_id` on `Encounter.EHR_Encounter_WIP` and `Encounter.Encounter_WIP` read
  `UNIQUEIDENTIFIER`, plus two `GC.deleted` rows with NULL. These sit outside the three
  real layers so they do not appear under any target; they need fixing directly.

`last_modified_by` is stamped with the signed-in user's **email**, matching the form
already used in these tables (`jsmith@example.com`) rather than the display name the
dependency graph uses.

## The Deployments tab

The release tracker that used to be `HDX Deployment Tracker.xlsx`, now in
`WH_HDX_DE_Silver.deploy.DeploymentTracker` — 197 rows across PI 27.2 (164, all
closed out) and PI 27.3 (33). One row is one component moving through one release:
what it is (PI, wave, release date, requestor, item, priority, component name and
type), who owns it (data modeling, developer, QA approval, UAT approver), free-text
notes, and the eleven gates it has to pass.

The UI shows **PI 27.3 onward** — earlier PIs stay in the table as history but are
filtered out of the Deployments tab.

Like S2T and the Dependency Graph, this writes **directly to the live
warehouse** — no staging copy, no publish step, a save takes effect immediately.
Unlike both, dg_tool created this table, so it has a real surrogate key and none of
the natural-key ambiguity S2T has to defend against.

### Each gate is a flag, a date *and* who passed it

**Ten** gates are tracked — data modeling complete, dev complete, code approved,
deployed to QA, QA approved, deployed to UAT, UAT approved, UAT smoke tests approved,
ready for prod deployment, deployed to prod — and each is **three** columns: `<Gate>`
(a bit), `<Gate>Date` (a nullable date) and `<Gate>By` (nullable initials). Passing
all ten is what "complete" means.

`<Gate>By` is stamped automatically from the signed-in user when the checkbox is
ticked in the grid — the same way `<Gate>Date` is — and is null wherever that is not
known: everything imported from the spreadsheet, and anything passed before this
column existed.

`ProdSmokeTestsPassed` is the eleventh column and is **not** one of them. It is not a
gate a component must clear to count as done, so it is not shown in the grid, not
editable in the form, and not counted in progress. The column and its 98 imported
values are still in the warehouse and still returned by the API — nothing was deleted —
they are simply not surfaced. Adding one line back to `GATES` in `web/src/types.ts`
would restore it.

Two of those are named differently in the UI than in the database. The spreadsheet's
*Ready for Code Review* and *Code Review Approved* are shown as **Dev Complete** and
**Code Approved**, because "CR" already means something else day to day here. The
columns keep their original names (`ReadyForCodeReview`, `CodeReviewApproved`) so the
importer still maps cleanly from the spreadsheet headers; only the labels changed, in
`GATES` in `web/src/types.ts`.

That pairing exists because **the spreadsheet only ever recorded Y/N**. For every
imported row the gate is known to have passed but the day is genuinely unknowable. One
date column would have forced a choice between inventing a date and throwing the fact
away; a bare flag would have thrown away the ability to measure cycle time going
forward. So both are stored, and "passed, day unknown" is a first-class state.

In the grid a ticked gate shows the month-day it was passed, or **–** when the day is
not known. Ticking stamps today, unticking clears flag and date together (a date with
the flag off would claim it passed on a day it did not), and **Edit** sets a specific
date for anything backfilled.

Progress is derived from the flags rather than stored, so there is no status column to
fall out of step with what actually happened. The grid shows *n*/10 and the furthest
gate passed — deliberately the furthest, not the first gap: gates legitimately get
passed out of order when a component goes back to QA after a UAT failure, and calling
such a row "stuck at code review" would be a lie.

### Filtering, and what the default hides

The toolbar filters on **PI**, **Release**, free text, and stage.

Release and release date are **one dropdown**, not two, because in the data every wave
maps to exactly one date — a separate date filter would only ever restate the release
you had already picked. Each option reads `#15 - 8/28/2026`, with `(Complete)` appended
when every component in that release has passed all eleven gates, so the picker itself
says which releases still need attention:

```
PI 27.2
  #9  - 6/26/2026 (Complete)
  #10 - 7/10/2026
  ...
```

Waves 1–3 of PI 27.2 show `no date` — those are the rows whose Release Date cell said
`Complete`. Options are scoped to the chosen PI, and when **All PIs** is selected they
are grouped under a PI heading, because wave 1 exists in both and the dates alone would
be the only thing telling them apart. The filter value encodes the PI for that reason.
Rows with no release at all sort last.

Release date also stays as its own **column**, formatted the same way, so the grid can
be read by date without touching the filter.

### How the grid reads

Columns run **Priority, Item, Component, PI / Release, Release date, Progress**, then
the ten gates, **two** of the four owners, and Notes. Item comes first among the text
columns because it is the one field every row has — the component is often not
identified yet, and shows **no component name provided** rather than repeating the item.

**Data Modeling and Developer are hidden from the grid**, not removed: both stay
editable in the form and stay part of the free-text search, they just do not get their
own columns. QA Approval and UAT Approver are what people scan for day to day; the other
two were tracked for completeness in the source spreadsheet but were never populated
there (0 of 236 rows have either), so the columns were pure width with nothing to show.
`TABLE_OWNERS` in `web/src/types.ts` is the grid's subset of the full `OWNERS` list the
form uses.

**Rows that share an Item within one release are grouped**: the Item is shown once,
spanning the rows for however many components fall under it, instead of repeating.
Twelve items in the current data cover two or three components each — three different
reasons `GC.HCPCS_Descriptions` was touched in wave 8 of PI 27.2, for instance. Rows
with no Item are never grouped with each other, even when adjacent: null means "not
identified yet," not "the same item," and merging two unrelated blanks would claim they
are one piece of work. Grouping depends on same-item rows staying adjacent, which the
server's `ORDER BY` guarantees today because every multi-component Item in the data
shares one Priority; a sort that could disagree within an Item would need to group
before applying it (see `groupByItem` in `web/src/deployments.ts`).

**PI and release are one column**, written `27.3.1`: the PI with its wave appended, the
`PI ` prefix dropped since every row carries it. It is one token you can say out loud,
and searching `27.3.1` finds it.

Everything sorts **oldest PI first** — 27.2 precedes 27.3 — then by release number, then
by priority, then by item. A release plan reads forwards.

**Priority is its own first column, shown as a flag** rather than the word itself: a red
**H**, orange **M**, green **L**, or grey **Unk** when it is not set. The flag is what
makes the column narrow enough to lead the grid, and the letter inside it means colour
never carries the meaning alone. Expect a lot of grey: the PI 27.2 sheet had no Priority
column, so all 164 of its rows are unknown. The flag uses its own palette rather than the
`--status-*` tokens, which are reserved for execution health — a high-priority component
is not an unhealthy one.

**The progress bar turns green once all ten gates are passed.** While any gate remains
outstanding it stays the neutral accent colour deliberately — a nine-of-ten row is not
"almost failing," and the status palette is reserved for that judgement. Complete is the
one state with nothing left to misjudge, so it alone gets `--status-good`, the same green
the rest of the app uses for "done."

**The stage filter defaults to "In progress"** — neither the backlog nobody has picked
up nor the work that is already done. `All stages`, `Not started` and `Completed only`
are also on offer. The count line says how many rows the current stage filter is hiding,
and an empty result offers a one-click *Show all stages* — so the default can never
quietly convince someone their work has vanished. The **Complete** KPI always counts the
full release, regardless of which stage is selected.

### Double-click Component Name or Notes to edit them in place

Those two fields are editable without opening the full **Edit** dialog: double-click,
type, and **Enter** or clicking away saves; **Escape** discards. This still goes through
the same full-row write the dialog uses — there is no partial-field write path other
than the dedicated gate endpoint — but only that one field changes, so a quick edit
doesn't need the dialog's overhead. Notes shows its full text on hover (it is truncated
with an ellipsis in the grid), with the same double-click hint appended.

Component Name keeps the identity rule the dialog enforces: clearing it is fine as long
as the row still has an Item, but clearing both is rejected with a toast rather than
saved, because a row with neither can never be found again. Notes has no such rule —
clearing it to blank always succeeds. For both fields, typing the same value back (after
trimming) is a no-op and never reaches the server, so it can't needlessly bump
`LastModified` and make the row look edited when nothing changed. A save that fails —
most commonly a 412 because someone else touched the row first — leaves the editor open
with what was typed still in it, the same "nothing typed is lost" rule the dialog follows.

Only one cell is ever "active" at a time (`inlineEdit` in `DeploymentsView.tsx` holds a
single row+field pair, not one per row), and double-clicking a second cell while the
first is still saving does not let that slower write clobber the newer edit — the
commit only clears the active-cell marker if it still refers to the same row and field
it started with.

### Component Type is a closed dropdown

Unlike Priority and the owner fields, which stay free text with a suggestion list,
**Component Type is a real `<select>`** over a fixed taxonomy (`COMPONENT_TYPES` in
`web/src/types.ts`):

```
Silver Table DDL (New Table)      Silver Stored Procedure (New)      Bronze Ingestion Pipeline
Gold Table DDL (New Table)        Gold Stored Procedure (New)        Fivetran Ingestion
Silver Table DDL (Update)         Silver Stored Procedure (Update)   Export Pipeline
Gold Table DDL (Update)           Gold Stored Procedure (Update)     Bronze Ingestion Pipeline (Update)
                                                                      Fivetran Ingestion (Update)
                                                                      Export Pipeline (Update)
                                                                      Schedule Change
```

The spreadsheet's Component Type column had 79 distinct free-text values in PI 27.2
alone, none of which match this list. Rather than force every historical row onto one of
these fifteen values (or blank), the form checks the row's current value against the
list when it opens: if it is not one of the fifteen, an extra option showing that exact
text with `(existing)` appears above them, so opening an old row for an unrelated edit —
fixing a typo in Notes, say — can never silently reset its Component Type to blank.
Saving without touching that field keeps the historical value; saving after actively
picking one of the fifteen replaces it.

The server no longer offers a Component Type suggestion list — that responsibility moved
entirely to `COMPONENT_TYPES` on the frontend, so there is exactly one place this
taxonomy is defined.

### Picking a release wave fills in its date

The Release Wave field knows the date already on record for every (PI, wave) pair, from
every loaded row regardless of the current filters. Picking wave 4 of PI 27.2 — by typing
it, or choosing PI first and then the wave — fills Release Date with 5/14/2026, because
every other component in that wave already carries that date.

It **only ever fills a blank Release Date and never overwrites one that is already set**.
That is what makes it safe to open an existing row for an unrelated edit: the row's own
date is already populated, so this never fires for it. It only helps when the field
starts empty — tracking a new component, or correcting a wave on one that never had a
date to begin with. Whatever gets filled in is still an ordinary date field afterwards;
nothing stops changing it by hand.

### What the sheet forced into the schema

* **Release wave.** The sheet's `Release` column is not the PI — it is a wave *within*
  it (1–15, or BACKLOG), and the PI comes from the tab name. Both are stored, because
  the same component ships in several waves of one PI.
* **`BACKLOG` is a section banner**, not a row: a lone value in the Release column
  above 19 items whose own Release cell is blank. The importer applies it to the rows
  beneath it, so those stay recognisable as backlog instead of importing as "no wave".
* **Component name is nullable.** 65 of the 73 PI 27.3 rows have no component yet —
  they are planned work identified only by `Item`. The grid falls back to showing the
  item, and the only hard rule is that a row must have one or the other.
* **`ComponentType` is part of the natural key.** PI 27.2 tracks
  `SP_Create_GC_Item_Prosthetic_Sheaths` three times in wave 1 — "units per package",
  "unit of measure", "Gold table update". Without the type those three collapse into
  one and two real rows are lost. It is a duplicate-detection heuristic, not an
  addressing key; rows are always addressed by `DeploymentId`.
* **`B` and `IP`** appear in `QA Approved` on 13 rows. Neither means approved, so the
  flag stays off and the raw value is preserved in `Notes` rather than discarded.
* **Priority** was `H`/`M`/`L` and is expanded to High/Medium/Low on import.
* **36 PI 27.2 rows** have the word `Complete` where a release date should be. That is
  a status, not a date, so it imports as NULL — the gates already record that it
  shipped. A further 14 had a date typed as text (`7/28/2026`), which is parsed.

### Importing the spreadsheet

```powershell
cd server
python import_tracker.py "C:\path\to\HDX Deployment Tracker.xlsx"          # dry run
python import_tracker.py "C:\path\to\HDX Deployment Tracker.xlsx" --apply
```

Idempotent — rows already present (matched on PI + wave + item + component + type) are
skipped, so a re-run only picks up what the sheet has gained since. The dry run reports
what it would insert, any duplicate keys inside the workbook, and anything it had to
skip.

The workbook's third sheet, **Bronze Table Ingestion Tracker**, is deliberately not
imported: it is a different shape entirely (a PG/MIRROR/FABRIC status per environment)
and needs its own table and page.

### Ticking a gate cannot overwrite anything else

Gate toggles go to `POST /api/deployments/{id}/gate`, which writes that one column.
Routing them through the full-row update would make a single click in a wide grid
capable of clobbering fields the clicker never scrolled to. The gate name is checked
against a fixed list before it reaches the statement, so it can never be user input.

### Concurrent edits cannot clobber each other

A release is tracked by several people at once. Every write sends the `LastModified`
the client read, and the server refuses with **412** if the row has moved since —
the same optimistic-concurrency rule as the S2T tab, with the same Reload banner
rather than a dismissable toast.

### Delete here really deletes

Unlike the Dependency Graph, where delete means deactivate, **Remove** deletes the row
and its gate history outright. Nothing downstream reads this table, so a removed row
leaves nothing dangling — and a tracker that accumulates dead rows forever stops being
readable. The UI confirms first and says plainly that there is no undo.

`sql/05_deployment_checks.sql` reports duplicate keys, gates dated out of order, and
anything in Production that never passed UAT.

## How writes reach the orchestrator

`orch.dependencygraph` lives in **`WH_HDX_DE_Silver`**, an ordinary Fabric
Warehouse table — plain T-SQL `INSERT`/`UPDATE`/`DELETE` work against it. It is
also the exact table `NB_Orchestrator_WH` reads to decide what to run, so a
save in the Dependency Graph tab is live the moment the request returns: no
staging copy, no drift, no publish step.

```
                    ┌──────────────────────────────────────────┐
  browser  ────────▶│  FastAPI  (localhost:8000)               │
  :5173             │  Azure AD token, validation, CRUD        │
                    └───────────────────┬──────────────────────┘
                                         │ T-SQL (read+write)
                                         ▼
                              WH_HDX_DE_Silver
                              orch.dependencygraph
                        ── what NB_Orchestrator_WH reads ──
```

Every environment's Health and Lineage tabs read `orch.dependencygraph`
directly, along with `orch.processexecutionstatus` and
`orch.orchestrator_run_logs` — all schema-qualified tables in that
environment's own warehouse, not a separate lakehouse item. DEV, QA, UAT and
PRD each have their own copy of this orch schema now.

---

## Sharing it with the team

```powershell
# bump VERSION first, then:
.\package.ps1
```

Produces `dist/dg_tool_v<VERSION>.zip` (~27 MB), named from the `VERSION` file. It
**refuses to overwrite an existing version** — pass `-Force` only if you really mean
to replace a build nobody has yet. The first share was date-named and a same-day fix
silently overwrote it, leaving no way to tell which build a teammate was running; the
version is now stamped into the zip name, the launcher banner, `README-FIRST.txt`, the
preflight output, and the app header, so "what version are you on?" always has an
answer.

To ship a change: edit `VERSION` (e.g. `1.0.2` → `1.0.3`), run `.\package.ps1`, send
the new zip. A teammate unzips it and double-clicks
`dg_tool.bat`; their browser opens the app and they click **Sign in with your Hanger
account**. Nothing is installed, nothing touches PATH or the registry, and deleting
the folder removes it.

The zip contains Microsoft's **embeddable CPython** plus every dependency, the built
UI, and `config.json`. That is deliberately not a PyInstaller `.exe`: an unsigned
novel executable is liable to be blocked by SmartScreen or Intune, whereas this is a
Microsoft-signed `python.exe` running a plain script — and when a teammate hits a
problem they can read what went wrong.

**The one thing it cannot bundle** is a *SQL Server ODBC driver*, which is a Windows
system component. Driver 18 is preferred, **Driver 17 is used automatically** if that
is all a machine has, and if neither is present preflight says which MSI to install.

> The driver must be the **x64** build — the bundled Python is 64-bit and cannot load a
> 32-bit driver. Both cases report the same `IM002 Data source name not found`, so the
> error lists the drivers Windows actually reports, which is what tells them apart.

### Sign-in

Teammates need no terminal and no `az login`. Order of preference:

1. **Cached** — signing in is once per machine; later starts are silent.
2. **Azure CLI** — used automatically if they happen to be `az login`-ed.
3. **Browser** — `InteractiveBrowserCredential` opens the *system* browser on a
   loopback redirect. This is not the embedded popup the Intune broker kills.
4. **Device code** — offered on the sign-in screen as a fallback, with the code shown
   **in the browser** rather than a console nobody is watching.

`get_token()` never starts an interactive flow — it raises `SignInRequired` and the UI
drives sign-in explicitly. A blocking auth call inside a request handler is what makes
a server hang with no explanation.

> **Verify browser sign-in before you distribute.** It is the one path that cannot be
> tested from an already-signed-in machine:
>
> ```powershell
> cd server; python check_browser_signin.py          # then --device to test the fallback
> ```
>
> It uses a throwaway cache, so it cannot disturb your working setup.

### Preflight

Every start prints a check list to the launcher's console, and the same list appears in
the browser — so a teammate sees *"Install the Microsoft ODBC Driver 18…"* rather than a
pyodbc stack trace:

```
  dg_tool preflight
    [ok  ] ODBC driver: ODBC Driver 18 for SQL Server
    [ok  ] Web UI: built assets found
    [ok  ] Health environments: DEV, QA, UAT, PRD
    [ok  ] Azure sign-in: Jane Smith <jsmith@example.com>
    [ok  ] Warehouse: WH_HDX_DE_Silver as jsmith@example.com
    [ok  ] Dependency Graph table: orch.dependencygraph
```

Checks are skipped rather than failed when an earlier one makes them impossible — a
"warehouse unreachable" error is noise when the real problem is that nobody signed in.
Start-up never aborts on a failed check: the UI loads and explains itself.

### What teammates can change

Worth being explicit before you hand it out, since everyone shares one DEV warehouse:

| Tab | Effect |
| --- | --- |
| **S2T** | Writes to the live `HDX` spec. Version-checked, so nobody can silently overwrite anyone. |
| **Dependency Graph** | Writes directly to `orch.dependencygraph`, the table `NB_Orchestrator_WH` actually reads. |
| **Lineage** | Read-only, all four environments. |
| **Health** | Read-only in every environment except for **Reset** on a retry count, which zeroes one `RetryCount` in DEV. |

Every write is stamped with the signed-in user, so edits stay attributable.

## One-time setup

Everything below is already done for **DEV** (`WH_HDX_DE_Silver`, workspace
id set via `DG_WORKSPACE_ID` — see `ENVIRONMENT_SETUP.md`). These steps are
for a fresh machine or a new environment.

**1. Create the tables** (both create-only, safe to re-run):

```powershell
python ..\fabric_warehouse_connectivity\fabric_query.py -f sql\01_create_graph_table.sql
python ..\fabric_warehouse_connectivity\fabric_query.py -f sql\04_create_deployment_tracker.sql
```

Preflight reports either one as a warning if it is missing, naming the script to run.
Every other tab keeps working in the meantime.

**2. Install dependencies:**

```powershell
python -m pip install -r server\requirements.txt
cd web; npm install; cd ..
```

**3. Import the deployment tracker spreadsheet** (dry run first, then `--apply`):

```powershell
python import_tracker.py "C:\path\to\HDX Deployment Tracker.xlsx"
```

Also idempotent. See [the Deployments tab](#the-deployments-tab) for what it does with
the parts of the sheet that do not map cleanly.

---

## Running it

```powershell
.\run.ps1
```

That starts the API on <http://127.0.0.1:8000> and the UI on
<http://localhost:5173>. Or run the two halves yourself:

```powershell
cd server; python -m uvicorn main:app --reload --port 8000
cd web;    npm run dev
```

### Signing in

Two token sources are tried in order:

1. **Azure CLI** — if you are already `az login`-ed, dg_tool reuses that session and
   starts with no prompt.
2. **Device code** — otherwise the terminal prints a URL and a short code. You
   complete MFA once; a saved authentication record makes later starts silent.

The interactive browser popup is deliberately not used: on these Intune-managed
machines it gets killed mid-flow, which is the same reason
[fabric_query.py](../fabric_warehouse_connectivity/fabric_query.py) uses device code.

Whoever is signed in is who the audit columns record. Note that `az login` as the
admin account stamps `CreatedBy` as `admdabell.az` rather than a display name like
`Jayraj Parsa`; sign in as your normal account if you want the friendlier form.

---

## The Lineage tab

A navigable diagram of every process. Drag to pan, scroll to zoom, `Fit` to frame it
all. Click any process for a popup showing **only that process's** upstream and
downstream lineage; click a node inside the popup to walk to it, and `Back` (or
Backspace) to retrace. `Show in table` jumps to that process's rows with filters
cleared.

Left to right is execution order — a node cannot start until everything to its left
has finished. Colour says *what* a node is (pipeline / stored proc / Gold), and a
dashed outline says it is not live (deactivated, or an external upstream with no row
of its own).

**Why it is laid out in clusters.** The graph is not one big DAG: 157 nodes and 143
edges form **38 disconnected components** — largest 42 nodes, then 12/10/10/8/7/6/6/5/5,
plus 19 processes with no lineage at all. A single global layered layout would put all
50 roots in one column and read as noise, so each component is laid out separately and
stacked, with the standalone processes collected into a compact grid at the bottom.

Layout is layered: rank by longest path, order within each rank by barycentre, then
place columns centred. It is deterministic, so the diagram looks the same on every
reload. No graph library is involved — it is plain SVG, which is why the whole bundle
is still 175 KB.

The popup also quantifies blast radius. `SP_Create_ItemComponentry_Silver`, for
instance, has 1 upstream and **38 downstream** processes, so the popup warns that
deactivating it would strand all 38.

## Environments on the Health tab

Each environment is a **separate Fabric workspace with its own lakehouse**, so
`processexecutionstatus` is a different table per environment. The Health tab has an
environment switcher; the Table and Lineage tabs stay on DEV, where the editable
`orch.dependencygraph` lives.

| Env | Promotion gate | State |
| --- | --- | --- |
| **DEV** | none — runs every row | ready (and the only editable one) |
| **QA** | none — runs every row | ready |
| **UAT** | `readyForUAT` | ready |
| **PRD** | `readyForProd` | configured, but **this account is not authorized** |

Adding an environment takes **one GUID**. `sql_endpoint` is optional: when omitted,
`endpoints.py` resolves it from the workspace's lakehouse on first use, since every
item in a workspace shares one SQL endpoint host. Environments merge into the
defaults by key, so an entry carries only what is missing:

```json
{ "environments": [ { "key": "prd", "workspace_id": "<prd-workspace-guid>" } ] }
```

**PRD is wired and waiting on access.** Every Fabric API call against its workspace
returns `401 {"errorCode":"Unauthorized","message":"User is not authorized"}`. Grant
the signed-in account at least Viewer on that workspace and the tab starts working
with no code or config change. Note that this is also why PRD does not appear in
`GET /v1/workspaces` — that endpoint lists only what the caller can access, so absence
there means "no permission", not "does not exist".

**Selecting an environment applies that environment's promotion gate**, mirroring
`NB_Orchestrator`: UAT is scoped to `readyForUAT`, PRD to `readyForProd`, and DEV and
QA are unfiltered because the orchestrator applies no filter there. So "in the graph"
and "untracked" always mean what they mean *to that environment's orchestrator*.

**Reads are per environment; writes can only ever land in DEV.** `execute()` in
`warehouse.py` deliberately takes no server/database argument, so there is no code path
that writes anywhere but the one warehouse dg_tool edits — that is structural, not a
convention to remember. The single write reachable from these tabs is **Reset** on a
retry count (below).

Failure detail works per environment too: the Why? button resolves the run against
that environment's own workspace and its own `PL_Run_Proc`/`PL_Run_Gold_Proc`.

## The Health tab

A service dashboard over `ProcessExecutionStatus`. That table belongs to the
orchestrator, so the tab reads it and stays out of the way — with exactly one
exception, described under [Resetting a retry count](#resetting-a-retry-count).
The tab label carries a badge with the needs-attention count, so a failure is
visible from the other tabs.

### Severity, not `Status`

The raw `Status` column is not a health signal. **91 days after its last success a
process still reads `Completed`** — and nothing alerts on green. Severity is
therefore derived from *when a process last succeeded*:

| Tier | Rule | Why |
| --- | --- | --- |
| **Failing** | last run failed, or never succeeded | the obvious case |
| **Stale** | succeeded, but not within 7 days | "stale green" — it may have quietly stopped being scheduled |
| **Healthy** | succeeded within 7 days | |
| **Unknown** | no status recorded | the orchestrator has never reported on it |
| **Deactivated** | `isActive = 0` in the graph | not expected to run, so never alarmed on |

Tiers are exclusive, so they sum to the row count and stack as a part-to-whole bar.
Deactivation deliberately outranks staleness — alarming on rows nobody schedules
would train people to ignore the dashboard.

### Why did it fail?

Failing rows carry a **Why?** button that reads the failure straight from the Fabric
API. `ProcessExecutionStatus.RunInstanceId` is a **pipeline job instance** id, and two
endpoints describe it:

| Endpoint | Gives |
| --- | --- |
| `GET /items/{item}/jobs/instances/{run}` | one job-level `failureReason`, plus status and timing |
| `POST /datapipelines/pipelineruns/{run}/queryactivityruns` | **per-activity** detail |

The second is far more useful. For a failed Gold stored proc the job-level message is
only *"Stored procedure has failed in the Gold Warehouse"*, while the activity level
gives the actual cause: *"Invalid column name 'appointment_date'. …"*. The dialog
leads with a **root cause** — the failed activity with wrappers (`Fail`,
`IfCondition`, …) and `ActionFailed` filtered out, since those only ever fail because
something inside them did.

Resolving the owning pipeline follows the same rules `NB_Orchestrator` uses to
trigger: a `PL_*` process has its own pipeline; a stored proc runs under
`PL_Run_Gold_Proc` or `PL_Run_Proc`. When a process has no graph row to read
`isStoredPro` from — an orphaned status row — the `SP_`/`PL_` naming convention
resolves it, and candidates are tried in turn.

Crucially, **`queryactivityruns` keys off the run id alone**, so activity detail still
works when the owning pipeline cannot be identified at all. That is why every one of
the 23 current failures returns detail rather than an error.

**Retention:** Fabric keeps job instances only for a limited window, so a months-old
outage returns nothing. The dialog then falls back to the message
`orchestrator_run_logs` captured at the time, in a separately labelled section so
logged text is never mistaken for live API detail. Of the 23 current failures, 20
resolve live and 3 fall back to the log.

> **A note on error text.** These messages are provider output and can quote schema
> and, in principle, data values. One Postgres error already says *"Detail redacted as
> it may contain sensitive data"* — Npgsql redacts by default. Leave it that way:
> enabling `Include Error Detail` on a connection to a patient-data source would put
> row values into these messages, and from there into this dialog.

### Resetting a retry count

A row whose `RetryCount` has run up sits there until someone clears it. Rows with a
count above zero carry a **Reset** button that sets that one `RetryCount` back to `0`,
so the orchestrator will attempt the process again on its next run.

It is the only write dg_tool makes to a table it does not own, so it is kept as narrow
as possible:

* **One process, one column.** `Status`, `LastRunTime`, `LastSuccess` and the rest are
  left exactly as the orchestrator wrote them — nothing here can make a failed run look
  like it succeeded.
* **Gated on the table, not the environment.** The button follows
  `EnvironmentInfo.statusWritable`, which is true only where `processexecutionstatus`
  lives in the warehouse `execute()` targets and false for a lakehouse copy, whose SQL
  analytics endpoint is read-only regardless — the server refuses with a 409 rather than
  failing mid-statement. All four environments are warehouse-resident now, so this only
  matters again if a future environment starts out on the older lakehouse layout.
* **Confirmed, and refused when ambiguous.** `ProcessExecutionStatus` has no surrogate
  key, so a process name matching more than one row is refused rather than updated — the
  same rule `s2t.py` applies to its natural-key writes.

The reset is logged server-side with the signed-in user and the previous count.

### It refreshes itself

The orchestrator writes constantly — failure counts and `Running` states moved
repeatedly within one session — so a dashboard left open goes misleading fast. While the
Health tab is open it re-reads every **60 seconds** and shows `updated 34s ago` next to
an Auto-refresh toggle.

Deliberately narrow: it polls only on that tab, only when the document is visible, and
catches up immediately when you switch back rather than waiting out the interval.
Polling a hidden tab would just burn warehouse queries.

During a poll the previous render is held at reduced opacity rather than replaced by a
skeleton, so there is no layout jump and the numbers stay readable. A **failed** poll
keeps the last good report on screen with a warning, instead of blanking a dashboard
someone is reading because one request timed out — only a user-initiated refresh or an
environment switch clears it, since showing DEV's numbers under a PRD heading would be
worse than showing nothing.

The other tabs do not poll. Dependency Graph has a Refresh button, Lineage derives from
whatever that tab last loaded, and S2T re-reads on focus (see below).

### What's on it

* **Hero figure** — the one number the view leads with: processes needing attention.
* **KPI row** — failing, stale, healthy, and untracked-row counts.
* **Health distribution** — part-to-whole bar across the five tiers.
* **"How long has it been failing?"** — failing processes bucketed by time since
  last success, which answers *chronic rot or fresh outage?* in a way a failure
  count cannot.
* **Triage table** — sorted by severity, then never-succeeded, then age, then blast
  radius. Click a process for its lineage popup.
* **Coverage gaps** — orphaned status rows and never-tracked processes.

**Blast radius** comes from the lineage graph: the transitive downstream count, so
you can see that a failing process is holding up nine others.

### Design constraints followed

Colour was chosen last and computed, not eyeballed. The status palette is a
**reserved fixed set** — never reused for a data series — validated against this
app's own surfaces with the skill's validator: CVD separation ΔE 11.3,
normal-vision ΔE 27.6. A four-role palette was rejected because `serious` and
`warning` measured ΔE 13.6, below the 15 floor; three roles clear it comfortably.
The warning step sits below 3:1 on white by design, so **every status colour ships
with an icon and a text label** and never carries meaning alone — including the
badges on the lineage diagram.

Failure-age buckets use a single-hue **ordinal** ramp (age is ordered magnitude,
not identity), passing all four ordinal checks in both modes. It inverts on the
dark surface because prominence, not absolute lightness, carries magnitude.

Every chart has a table-view twin, no chart has a second y-axis, in-segment labels
render only when they actually fit, and no sparklines are shown — `ProcessExecutionStatus`
holds only a current snapshot, so a trend line would be fabricated.

## Environment filter

Both tabs share an environment selector, and the choice persists when you switch
between them. It mirrors exactly what `NB_Orchestrator` does:

```python
if current_env.upper() == "UAT":   dependency_df = dependency_df.filter(col("readyForUAT"))
elif current_env.upper() == "PRD": dependency_df = dependency_df.filter(col("readyForProd"))
```

| Option | Rows | Meaning |
| --- | --- | --- |
| All environments | 192 | Every row, regardless of promotion. |
| Dev — everything | 192 | The orchestrator applies **no** promotion filter in Dev, so Dev runs every row. Same set as All; both are listed because the counts make that obvious. |
| UAT | 151 | `readyForUAT` — what the orchestrator runs in UAT. |
| PRD | 139 | `readyForProd` — what the orchestrator runs in PRD. |
| Dev only, not promoted | 41 | Promoted to neither, so they never leave Dev. |

Selecting UAT or PRD in the Lineage tab redraws the graph **as the orchestrator sees
it in that environment** — 151 rows collapse to 122 nodes / 123 edges for UAT, and 139
rows to 110 nodes / 115 edges for PRD.

Promotion is per row, i.e. per dependency *edge*, not per process — a process can be
promoted with one upstream and not another. So the filter is applied to rows *before*
the graph is built. Filtering nodes afterwards would leave edges whose upstream is not
promoted, drawing dependencies the orchestrator would not honour.

**It flags broken promotions.** If a process is promoted to UAT or PRD but one of its
upstreams is not, the orchestrator would hold it behind something it never schedules.
That upstream shows as a dashed external node and is called out in red above the
diagram. Your data currently has none in either environment — the detector is verified
against a synthetic break rather than against an empty result.

No such warning appears for **Dev only**: a dev-only row depending on a promoted
process is completely normal, and 5 of them do.

## What it validates

The notebook accepts anything you type. dg_tool checks the whole graph on every
write — cheap at 192 rows, and it catches the errors that are most expensive to
find in production.

**Blocks the save:**

| Rule | Why |
| --- | --- |
| Dependency cycle (A → B → A) | The orchestrator would deadlock at run time with no clear cause. |
| A process depending on itself | Trivial cycle. |
| Duplicate `(Process, Dependency)` | That pair is the natural key rows are matched on, so a duplicate makes editing ambiguous. |
| Stored proc with no `WarehouseName` | The orchestrator has nowhere to run it. |
| `RunTimes` not a 5-field cron expression | Would silently never fire. |

**Warns only:**

| Rule | Why it is not blocking |
| --- | --- |
| Dependency that is not itself a process | Legitimate for an externally-triggered upstream, but usually a typo. |
| `WarehouseName` set on a non-stored-proc row | Ignored by the orchestrator, harmless. |

Only issues *caused by your change* block a save, so a pre-existing problem
elsewhere in the table never stops you editing an unrelated row.

The current table has **0 errors and 4 warnings** — `SP_Create_Billing_Invoice`
depends on `SP_Create_Claims_Header`, `SP_Create_Location_Location` and
`SP_Create_Transaction_Charges`, and `SP_Create_Encounter_EHR_Invoice_Header`
depends on `SP_Create_Location_Location`, none of which exist as processes.

---

## dg_tool is the only front door

**Edits to `dependencygraph` go through dg_tool, not through
`NB_Create_Orch_LH_Resources`.** That notebook stays useful for creating the tables
and for one-off Spark work, but its `data = [Row(...)]` list should no longer be the
way rows are changed.

This mattered more when edits landed in a separate staging table that could not
see changes made anywhere else, and it bit us within an hour of standing the
tool up: on 2026-08-13 a colleague ran the notebook and renamed
`SP_Create_Encounter_Transaction_Line` (no dependency) to
`SP_Create_Encounter_EHR_Transaction_Line → SP_Create_Encounter_EHR_Charges`,
deleting the old row, and staging (seeded minutes earlier) didn't know either
had happened — the renamed row was invisible to the app, and the old row
looked like unpublished new work. Since dg_tool now edits
`orch.dependencygraph` directly rather than a separate copy, that specific
failure mode — two tables silently disagreeing — can't recur; the tool that
reconciled it (`seed_staging.py`) is gone along with the staging table it
reconciled. The underlying lesson stands regardless: **`NB_Create_Orch_LH_Resources`
editing the table by hand, concurrently with dg_tool, is still not safe** — a
row deleted or renamed there is still a row dg_tool never sees deleted or
renamed.

## Delete means deactivate

There is no hard-delete path. **Delete** sets `isActive = 0`: the orchestrator skips
the row, and it stays in the table and auditable, restorable with one click.
Physical removal remains a deliberate manual operation.

---

## Layout

```
dg_tool/
├── run.ps1                     start both halves
├── sql/
│   ├── 01_create_graph_table.sql  create-only DDL for orch.dependencygraph
│   ├── 03_checks.sql           integrity checks; every query should return 0 rows
│   ├── 04_create_deployment_tracker.sql  create-only DDL for the release tracker
│   ├── 05_deployment_checks.sql          integrity checks for the tracker
│   ├── 06_add_lookback_column.sql        adds lookbackRequired to an existing graph table
│   ├── 07_add_gate_signoff_by_columns.sql adds <Gate>By initials columns to the tracker
│   └── 08_add_requestor_column.sql       adds Requestor to the tracker
├── server/
│   ├── config.py               defaults + config.json / DG_* env overrides
│   ├── fabric_auth.py          az CLI, falling back to device code; caches tokens
│   ├── net.py                  routes TLS verification through the OS trust store
│   ├── fabric_jobs.py          failure detail from the Fabric jobs API
│   ├── s2t.py                  CRUD over HDX.Table_Metadata / Table_Columns
│   ├── deployments.py          CRUD over deploy.DeploymentTracker
│   ├── import_tracker.py       one-time xlsx -> deployment tracker import
│   ├── warehouse.py            pyodbc layer; all values passed as ? parameters
│   ├── queries.py              CRUD over orch.dependencygraph
│   ├── validation.py           cycle detection and graph rules
│   └── main.py                 FastAPI routes
└── web/                        React + TypeScript + Vite (no graph library)
    └── src/
        ├── App.tsx             tabs, filters, search, save/deactivate flows
        ├── api.ts              typed fetch layer, surfaces server messages verbatim
        ├── env.ts              Dev/UAT/PRD promotion rules, per NB_Orchestrator
        ├── health.ts           severity model, age buckets, relative ages
        ├── deployments.ts      gate progress, stage model, local-date stamping
        ├── lineage.ts          graph model, layered layout, lineage traversal
        └── components/         S2TView, RowTable, RowForm, HealthPanel,
                                StatusDashboard, DeploymentsView, DeploymentForm,
                                LineageView, LineageFocus, GraphCanvas,
                                FailureModal
```

`config.json` and the token cache are gitignored. Nothing in this tool stores a
secret: it holds only Fabric object identifiers (the same ones already in
`.mcp.json`), and all credentials live in the OS-encrypted token cache.

---

## Notes

* **Token expiry.** The az CLI token expires roughly hourly. `uvicorn` reconnects and
  fetches a fresh token automatically; if the CLI session itself has expired, run
  `az login --tenant <your-tenant-id>` and refresh the page (the tenant id is
  whatever you set `DG_TENANT_ID` to — see `ENVIRONMENT_SETUP.md`).
* **Transient `OSError: [Errno 22]` on start-up.** OneDrive occasionally hydrates a
  file inside `.venv` mid-import and pydantic's plugin loader fails. Re-running fixes
  it; `run.ps1` sets `PYDANTIC_DISABLE_PLUGINS=1` to avoid the whole class of failure
  (dg_tool uses no pydantic plugins).
* **TLS to the Fabric API needs `truststore`.** These workstations sit behind a
  TLS-inspecting proxy whose root CA is in the Windows store but not in certifi's
  bundle, so `requests` fails with *"unable to get local issuer certificate"*. Reading
  the Windows store directly does not help either, because that CA's Basic Constraints
  extension is not marked critical and OpenSSL 3 rejects it. `server/net.py` routes
  verification through the OS verifier via `truststore`, which accepts it while still
  checking signature, expiry and hostname — this is **not** `verify=False`. Without
  `truststore` installed, the Health tab's Why? button is the only thing that breaks.
* **This is a local tool by design.** Each person runs it and authenticates as
  themselves, so no app registration or hosting review is needed. Turning it into a
  shared hosted app means an Azure app registration, MSAL in the browser, redirect
  URIs and a security review — the API layer is already shaped for that, but nothing
  here assumes it.
* `dg_tool/index.html` at the top level is a leftover empty file, unrelated to the
  app; the real entry point is `web/index.html`. Safe to delete.
