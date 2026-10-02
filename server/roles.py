"""Who may edit a dependency graph outside DEV.

The rule is deliberately a single question: **is this user a Fabric Admin of the
production workspace?** If so they may write to QA and UAT as well as DEV -- both
the dependency graph and the Health tab's retry reset. If not, they get DEV only
-- which is unchanged from how the tool has always worked, and is why a
Contributor still edits DEV exactly as before.

Production admin is the gate rather than each environment's own role because the
environments are not independent: QA and UAT exist to rehearse what lands in PRD,
so the people entitled to change what runs there are the people already trusted
with PRD. It also avoids a rule nobody could reason about, where someone might
edit UAT but not QA.

**Why a 403 is an answer, not an error.** Fabric's roleAssignments endpoint
requires Admin or Member on the workspace being asked about, so a caller who is
merely a Contributor or Viewer cannot read their own role there. That sounds like
a dead end but it completes the decision: a refusal proves the caller is below
Member, and therefore not an Admin. A caller who *is* an Admin gets a 200 that
names them. Both branches are conclusive, so no case is left to a guess.

Group membership comes from the token's `groups` claim, because real access is
granted through Entra groups (HDX-Fabric-DEV-Members and friends) rather than to
individuals -- matching only the user's own object id would miss nearly everyone.
Note the claim rides on the *SQL* token: the Fabric-scoped token for this app
registration carries `wids` but no `groups`.
"""
from __future__ import annotations

import logging
import threading
import time

from fastapi import HTTPException

import fabric_auth
import fabric_jobs
from config import CONFIG
from fabric_auth import SQL_SCOPE, SignInRequired, get_token

log = logging.getLogger("dg_tool.roles")

# The role that grants cross-environment editing. Member is deliberately not
# enough: Member can administer content, Admin owns the workspace.
_ADMIN_ROLE = "admin"

# Long enough that a write burst costs one Fabric call, short enough that adding
# somebody to the PRD admins group takes effect without restarting dg_tool.
_TTL_SECONDS = 600

_lock = threading.Lock()
# oid -> (is_admin, monotonic time it was decided)
_decided: dict[str, tuple[bool, float]] = {}


def _identity_claims() -> dict:
    return fabric_auth._decode_claims(get_token(SQL_SCOPE))


def current_username() -> str | None:
    """UPN of the signed-in operator, or None if nobody is signed in."""
    try:
        identity = fabric_auth.get_identity()
    except SignInRequired:
        return None
    return identity.get("username") or None


def admin_environment():
    """The environment whose Admin role grants cross-environment editing."""
    try:
        return CONFIG.environment(CONFIG.admin_env)
    except KeyError:
        return None


def _resolve_admin() -> bool:
    """Ask Fabric whether this user is an Admin of the production workspace."""
    env = admin_environment()
    if env is None or not env.workspace_id:
        log.warning(
            "admin_env %r is not a configured environment with a workspace id; "
            "nobody will be treated as an administrator.",
            CONFIG.admin_env,
        )
        return False

    claims = _identity_claims()
    oid = claims.get("oid")
    groups = set(claims.get("groups") or [])
    if not oid:
        return False
    if not groups and "_claim_names" in claims:
        # Entra replaces `groups` with a Graph pointer once a user is in more
        # groups than a token can carry. Direct assignments still resolve below;
        # a group-granted admin would be missed, so say so rather than silently
        # denying someone their access with no explanation anywhere.
        log.warning(
            "Token reports group overage, so group-based admin cannot be checked "
            "for %s. Only a direct role assignment will be seen.",
            claims.get("upn") or oid,
        )

    try:
        assignments = fabric_jobs.workspace_role_assignments(env.workspace_id)
    except fabric_jobs.WorkspaceRoleHidden:
        # Conclusive: the endpoint needs Admin or Member, so being refused means
        # this user is neither, and so is not an Admin. See the module docstring.
        return False
    except Exception as exc:
        # Anything else (network, outage) is genuinely unknown. Deny, because the
        # safe answer for a write into a deployed environment is no, but log it so
        # it is not mistaken for a permissions decision.
        log.warning("Could not determine %s admin status: %s", env.label, exc)
        return False

    for assignment in assignments:
        if str(assignment.get("role", "")).lower() != _ADMIN_ROLE:
            continue
        principal = assignment.get("principal") or {}
        principal_id = principal.get("id")
        if principal_id == oid:
            return True
        if str(principal.get("type", "")).lower() == "group" and principal_id in groups:
            return True
    return False


def is_admin() -> bool:
    """Whether the signed-in user may edit environments other than DEV.

    Cached per user for _TTL_SECONDS: this is consulted on /api/me and again on
    every cross-environment write, and each miss is a Fabric API round-trip.
    """
    try:
        oid = _identity_claims().get("oid")
    except SignInRequired:
        return False
    if not oid:
        return False

    with _lock:
        cached = _decided.get(oid)
        if cached and time.monotonic() - cached[1] < _TTL_SECONDS:
            return cached[0]

    # Resolved outside the lock: it makes an HTTP call, and a duplicate under a
    # race is harmless.
    decided = _resolve_admin()
    with _lock:
        _decided[oid] = (decided, time.monotonic())
    return decided


def require_admin_everywhere(action: str) -> None:
    """Refuse an action that needs an admin wherever it points, DEV included.

    Distinct from require_admin, which exempts DEV because editing that staging
    table by hand has always been open to anyone. Copying rows between
    environments is not that: it is a reconciliation across a boundary, and the
    person doing it is deciding which environment is authoritative. That
    judgement belongs to the same people trusted with production regardless of
    which side happens to receive the write.
    """
    if is_admin():
        return

    target = admin_environment()
    authority = target.label if target else CONFIG.admin_env.upper()
    who = current_username() or "you"
    raise HTTPException(
        status_code=403,
        detail=(
            f"{action} requires the Fabric Admin role on the {authority} workspace, "
            f"which \"{who}\" does not hold. Editing DEV directly on the Dependency "
            "Graph tab is unaffected."
        ),
    )


def require_admin(env, action: str = "Editing") -> None:
    """Refuse a write outside DEV unless the user is a production admin.

    Covers both writes the Dependency Graph tab makes and the Health tab's retry
    reset, so there is one rule rather than one per surface.

    DEV is deliberately not covered: it has always been writable by anyone who
    can reach the app, and gating it would change the tool for everybody rather
    than adding the one restriction being asked for.

    `action` only shapes the message ("Editing UAT…", "Resetting retries in UAT…").
    """
    if env.key == CONFIG.environments[0].key:
        return
    if is_admin():
        return

    target = admin_environment()
    authority = target.label if target else CONFIG.admin_env.upper()
    who = current_username() or "you"
    raise HTTPException(
        status_code=403,
        detail=(
            f"{action} {env.label} requires the Fabric Admin role on the {authority} "
            f"workspace, which \"{who}\" does not hold. Ask a {authority} workspace "
            f"admin to add you, or work in DEV instead."
        ),
    )
