"""TLS trust setup for outbound HTTPS.

These workstations sit behind a TLS-inspecting proxy whose root CA is installed in
the Windows certificate store but is not in certifi's bundle, so `requests` fails
with:

    SSLCertVerificationError: unable to get local issuer certificate

Worse, that CA has a Basic Constraints extension that is not marked critical, which
OpenSSL 3 rejects even when reading the Windows store directly:

    Basic Constraints of CA cert not marked critical

`truststore` routes verification through the *platform's* own verifier (Windows
CryptoAPI) instead of OpenSSL's, which accepts the corporate CA while still
checking signature, expiry and hostname. That is why this is not `verify=False`:
certificate verification stays fully on, it is simply performed by the OS.

Import this module before any `requests` call.
"""
from __future__ import annotations

import logging

log = logging.getLogger("dg_tool.net")

_injected = False


def enable_system_trust() -> bool:
    """Route TLS verification through the OS trust store. Idempotent."""
    global _injected
    if _injected:
        return True

    try:
        import truststore
    except ImportError:
        log.warning(
            "truststore is not installed; HTTPS calls to the Fabric API will fail "
            "behind the corporate proxy. Install it with: pip install truststore"
        )
        return False

    truststore.inject_into_ssl()
    _injected = True
    return True


enable_system_trust()
