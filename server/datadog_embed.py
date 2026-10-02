"""Signed URLs for the Monitoring tab's embedded Datadog dashboard.

Datadog's secure embed validates a token/nonce/ts query string against an HMAC-SHA256
of "{nonce}|{timestamp}" keyed by a credential from the dashboard's Share > Secure
setup. The token is valid for 30 minutes and single-use; once a browser redeems one,
Datadog grants that browser 30 days of access to the dashboard, so minting a fresh
token per page load (rather than caching one) costs nothing extra.

The credential is read straight from the environment, never from config.json, so it
can never end up written to a file this repo's tooling treats as shareable.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from urllib.parse import urlencode

from config import CONFIG

_CREDENTIAL_ENV_VAR = "DD_EMBED_CREDENTIAL"


class DatadogEmbedUnavailable(RuntimeError):
    """The dashboard URL or its signing credential is not configured."""


def configured() -> bool:
    return CONFIG.datadog_configured and bool(os.environ.get(_CREDENTIAL_ENV_VAR))


def signed_url() -> str:
    """A fresh, signed embed URL for the configured dashboard.

    Raises DatadogEmbedUnavailable if either the dashboard URL (config.json) or the
    signing credential (the DD_EMBED_CREDENTIAL environment variable) is missing.
    """
    if not CONFIG.datadog_dashboard_url:
        raise DatadogEmbedUnavailable(
            "datadog_dashboard_url is not set in server/config.json."
        )

    credential = os.environ.get(_CREDENTIAL_ENV_VAR)
    if not credential:
        raise DatadogEmbedUnavailable(
            f"{_CREDENTIAL_ENV_VAR} is not set. Set it to the credential from "
            "Datadog's Share Dashboard > Secure setup and restart dg_tool."
        )

    nonce = secrets.token_hex(16)
    timestamp = int(time.time())
    message = f"{nonce}|{timestamp}".encode("utf-8")
    token = hmac.new(credential.encode("utf-8"), message, hashlib.sha256).hexdigest()

    query = urlencode({"token": token, "nonce": nonce, "ts": str(timestamp)})
    return f"{CONFIG.datadog_dashboard_url}?{query}"
