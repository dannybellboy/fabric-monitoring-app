"""Azure AD authentication for dg_tool.

Designed so a teammate can double-click the launcher and sign in **in their
browser**, with no terminal and no `az login`.

## Acquiring a token

    1. in-memory cache            instant
    2. persisted MSAL cache       silent, survives restarts (sign in once per machine)
    3. Azure CLI                  silent, if they happen to be az-logged-in
    4. interactive                only when the UI explicitly asks

Steps 1-3 are silent. get_token() never starts an interactive flow -- it raises
`SignInRequired` instead. That matters: an interactive flow blocks until a human
finishes it, and a blocking auth call inside a request handler is exactly what
makes a server hang with no explanation.

## Interactive sign-in

`sign_in()` runs in a background thread and the UI polls `auth_status()`. Two
methods:

* **browser** (default) -- `InteractiveBrowserCredential` opens the *system*
  browser and listens on a loopback redirect. This is not the embedded popup that
  the Intune broker kills, which is why it is worth preferring over device code.
* **device** -- fallback. The code and URL are exposed through `auth_status()` so
  the UI can display them; nothing is printed to a console nobody is watching.

Either way the resulting AuthenticationRecord is persisted, so it is a one-time
step per machine and every later start is silent.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from pathlib import Path

from azure.core.exceptions import ClientAuthenticationError
from azure.identity import (
    AuthenticationRecord,
    AzureCliCredential,
    DeviceCodeCredential,
    InteractiveBrowserCredential,
    TokenCachePersistenceOptions,
)

log = logging.getLogger("dg_tool.auth")

# Azure CLI's well-known first-party public client id. It supports the device-code
# and loopback-redirect flows and already has consent for the Azure SQL and Fabric
# resources, which is why dg_tool needs no app registration of its own.
AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
# Your Entra tenant id. Set via the DG_TENANT_ID environment variable --
# see ENVIRONMENT_SETUP.md.
TENANT_ID = os.environ.get("DG_TENANT_ID", "")

SQL_SCOPE = "https://database.windows.net/.default"
FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default"

# The AuthenticationRecord says *which account* to use. Not a secret, but it lives
# outside the OneDrive tree so it is never synced; the tokens themselves are in the
# OS-encrypted cache (DPAPI on Windows).
_RECORD_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "dg_tool"
_RECORD_PATH = _RECORD_DIR / "auth_record.json"
_CACHE_NAME = "dg_tool"

_REFRESH_MARGIN_SECONDS = 300

_lock = threading.Lock()
_tokens: dict[str, tuple[str, float]] = {}
_scope_locks: dict[str, threading.Lock] = {}
_cli: AzureCliCredential | None = None
_cli_failed = False
_silent = None  # credential built from the persisted record

# Set by sign_out(), cleared by the next sign_in(). Without this, sign_out()
# only forgets dg_tool's own record -- on a machine with an active `az login`
# session, the very next call would silently fall back to the Azure CLI
# credential and re-authenticate as the same person, making sign-out a no-op.
_signed_out = False

# Interactive sign-in progress, polled by the UI.
_signin: dict = {"state": "idle", "method": None, "deviceCode": None, "error": None}


class SignInRequired(RuntimeError):
    """No silent path to a token; the user must sign in interactively."""


# --------------------------------------------------------------------------
# Persisted account
# --------------------------------------------------------------------------


def _load_record() -> AuthenticationRecord | None:
    if not _RECORD_PATH.exists():
        return None
    try:
        return AuthenticationRecord.deserialize(_RECORD_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None  # corrupt or from an older version -> sign in again


def _save_record(record: AuthenticationRecord) -> None:
    _RECORD_DIR.mkdir(parents=True, exist_ok=True)
    _RECORD_PATH.write_text(record.serialize(), encoding="utf-8")


def _cache_options() -> TokenCachePersistenceOptions:
    return TokenCachePersistenceOptions(name=_CACHE_NAME)


def _silent_credential():
    """A credential that can refresh silently, or None if nobody has signed in.

    Built from the persisted record. `InteractiveBrowserCredential` is used as the
    carrier because with a record and a cache it refreshes without prompting; it
    would only prompt if asked to authenticate(), which this never does.
    """
    global _silent
    if _silent is not None:
        return _silent

    record = _load_record()
    if record is None:
        return None

    _silent = InteractiveBrowserCredential(
        client_id=AZURE_CLI_CLIENT_ID,
        tenant_id=record.tenant_id or TENANT_ID,
        cache_persistence_options=_cache_options(),
        authentication_record=record,
        # Never open a browser from a silent path; a prompt here would hang a request.
        disable_automatic_authentication=True,
    )
    return _silent


# --------------------------------------------------------------------------
# Tokens
# --------------------------------------------------------------------------


def _cached(scope: str) -> str | None:
    with _lock:
        entry = _tokens.get(scope)
    if not entry:
        return None
    token, expires_on = entry
    return token if expires_on - time.time() > _REFRESH_MARGIN_SECONDS else None


def _acquire_silently(scope: str):
    """Try every silent source. Returns an AccessToken or None."""
    global _cli, _cli_failed

    if _signed_out:
        return None

    credential = _silent_credential()
    if credential is not None:
        try:
            return credential.get_token(scope)
        except Exception as exc:  # noqa: BLE001 -- any failure just means "not silent"
            log.info("Silent refresh unavailable (%s)", exc.__class__.__name__)

    if not _cli_failed:
        try:
            if _cli is None:
                _cli = AzureCliCredential()
            return _cli.get_token(scope)
        except ClientAuthenticationError as exc:
            # No az session, or it cannot serve this scope. Remember, so later calls
            # skip a subprocess that is going to fail anyway.
            _cli_failed = True
            log.info("Azure CLI unavailable (%s)", exc.__class__.__name__)

    return None


def get_token(scope: str = SQL_SCOPE) -> str:
    """A token for `scope`, from cache or a silent refresh.

    Raises SignInRequired rather than prompting -- see the module docstring.
    """
    cached = _cached(scope)
    if cached:
        return cached

    with _lock:
        scope_lock = _scope_locks.setdefault(scope, threading.Lock())

    # Per-scope so two scopes can be fetched concurrently and a slow fetch for one
    # never blocks readers of another.
    with scope_lock:
        cached = _cached(scope)
        if cached:
            return cached

        access = _acquire_silently(scope)
        if access is None:
            raise SignInRequired(
                "Not signed in to Azure. Use the Sign in button, or run "
                f'az login --tenant "{TENANT_ID}".'
            )

        with _lock:
            _tokens[scope] = (access.token, float(access.expires_on))
        return access.token


def _decode_claims(token: str) -> dict:
    """Read our own token's payload without verifying it.

    Only used to display who is signed in and to stamp audit columns. Not a trust
    decision -- Fabric enforces the authorization that matters when the token is
    used, so verifying the signature here would add nothing.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def get_identity() -> dict:
    """{name, username} for the signed-in user. Raises SignInRequired if nobody is."""
    claims = _decode_claims(get_token(SQL_SCOPE))
    username = (
        claims.get("upn")
        or claims.get("unique_name")
        or claims.get("preferred_username")
        or ""
    )
    return {"name": claims.get("name") or username or "unknown", "username": username}


# --------------------------------------------------------------------------
# Interactive sign-in
# --------------------------------------------------------------------------


def auth_status() -> dict:
    """Whether we can act, plus any in-progress sign-in — for the UI's gate."""
    with _lock:
        progress = dict(_signin)

    try:
        identity = get_identity()
        return {
            "signedIn": True,
            "name": identity["name"],
            "username": identity["username"],
            "signIn": progress,
        }
    except SignInRequired as exc:
        return {
            "signedIn": False,
            "name": None,
            "username": None,
            "reason": str(exc),
            "signIn": progress,
        }
    except Exception as exc:  # noqa: BLE001
        return {"signedIn": False, "name": None, "username": None,
                "reason": f"{exc.__class__.__name__}: {exc}", "signIn": progress}


def _set_progress(**fields) -> None:
    with _lock:
        _signin.update(fields)


def _device_prompt(verification_uri: str, user_code: str, expires_on) -> None:
    """Publish the code for the UI instead of printing to a console."""
    _set_progress(
        deviceCode={
            "url": verification_uri,
            "code": user_code,
            "expiresAt": getattr(expires_on, "isoformat", lambda: None)(),
        }
    )
    # Also print it, for anyone who *is* running from a terminal.
    print(f"\n  Sign in at {verification_uri} and enter code {user_code}\n", flush=True)


def _run_sign_in(method: str) -> None:
    global _silent
    try:
        if method == "device":
            credential = DeviceCodeCredential(
                client_id=AZURE_CLI_CLIENT_ID,
                tenant_id=TENANT_ID,
                prompt_callback=_device_prompt,
                cache_persistence_options=_cache_options(),
            )
        else:
            credential = InteractiveBrowserCredential(
                client_id=AZURE_CLI_CLIENT_ID,
                tenant_id=TENANT_ID,
                cache_persistence_options=_cache_options(),
            )

        record = credential.authenticate(scopes=[SQL_SCOPE])
        _save_record(record)

        with _lock:
            # Drop the cached credential and tokens so the next call rebuilds from
            # the new record -- otherwise a re-sign-in as a different account would
            # keep serving the old identity.
            _tokens.clear()
        _silent = None

        # Prove it worked before reporting success.
        get_identity()
        _set_progress(state="ok", deviceCode=None, error=None)
        log.info("Interactive sign-in complete (%s)", method)
    except Exception as exc:  # noqa: BLE001 -- surfaced to the UI verbatim
        log.error("Sign-in failed (%s): %s", method, exc)
        _set_progress(state="failed", deviceCode=None, error=f"{exc}")


def sign_in(method: str = "browser") -> dict:
    """Start an interactive sign-in in the background. The UI polls auth_status().

    Returns immediately: the browser flow blocks until the user finishes, and
    holding an HTTP request open for that would just look like a hang.
    """
    global _signed_out
    if method not in ("browser", "device"):
        raise ValueError(f"Unknown sign-in method: {method!r}")

    with _lock:
        if _signin["state"] == "pending":
            return dict(_signin)
        _signin.update(state="pending", method=method, deviceCode=None, error=None)

    # An explicit sign-in always re-enables silent fallback (Azure CLI included),
    # even if the person signed out earlier in this run.
    _signed_out = False
    threading.Thread(target=_run_sign_in, args=(method,), daemon=True).start()
    return {"state": "pending", "method": method, "deviceCode": None, "error": None}


def sign_out() -> None:
    """Forget the account, so the next sign-in can use a different one.

    Also blocks the Azure CLI fallback until the next sign_in(): otherwise, on a
    machine with an active `az login` session, the very next silent read would
    re-authenticate as the same person and sign-out would look like it did
    nothing.
    """
    global _silent, _cli, _cli_failed, _signed_out
    with _lock:
        _tokens.clear()
        _signin.update(state="idle", method=None, deviceCode=None, error=None)
    _silent = None
    _cli = None
    _cli_failed = False
    _signed_out = True
    try:
        _RECORD_PATH.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("Could not remove %s: %s", _RECORD_PATH, exc)
