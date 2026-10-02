"""Verify that browser sign-in works on a managed machine.

Run this once before handing the package to the team. It exercises exactly the
credential the Sign in button uses, and nothing else -- it does not touch dg_tool's
own token cache, so a failure here cannot break your working setup.

Why it needs checking: these workstations kill the *embedded* auth popup, which is
why the older fabric_query.py used device code. `InteractiveBrowserCredential` is a
different mechanism -- it opens the system browser and listens on a loopback
redirect -- so it may well work, but that is worth proving rather than assuming.

    python check_browser_signin.py            # test the browser flow
    python check_browser_signin.py --device   # test the device-code fallback

A browser tab will open. Sign in there. If nothing opens, or it fails, the device
code fallback is the answer and the Sign in screen already offers it.
"""
from __future__ import annotations

import argparse
import sys

from azure.identity import DeviceCodeCredential, InteractiveBrowserCredential

from fabric_auth import AZURE_CLI_CLIENT_ID, SQL_SCOPE, TENANT_ID, _decode_claims


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", action="store_true", help="test the device-code flow instead")
    parser.add_argument("--timeout", type=int, default=180, help="seconds to wait (default 180)")
    args = parser.parse_args(argv)

    method = "device code" if args.device else "system browser"
    print(f"\nTesting sign-in via {method}.")
    print("A separate, throwaway cache is used, so your dg_tool sign-in is untouched.\n")

    common = dict(client_id=AZURE_CLI_CLIENT_ID, tenant_id=TENANT_ID)

    if args.device:
        def prompt(uri, code, expires_on):
            print("=" * 64)
            print(f"  Open:       {uri}")
            print(f"  Enter code: {code}")
            print("=" * 64, flush=True)

        credential = DeviceCodeCredential(prompt_callback=prompt, timeout=args.timeout, **common)
    else:
        print("Opening your browser now...\n", flush=True)
        credential = InteractiveBrowserCredential(timeout=args.timeout, **common)

    try:
        token = credential.get_token(SQL_SCOPE)
    except Exception as exc:  # noqa: BLE001 -- the whole point is to see the failure
        print(f"\nFAILED: {exc.__class__.__name__}: {exc}\n")
        if not args.device:
            print("The browser flow did not complete. Try the fallback:")
            print("    python check_browser_signin.py --device")
            print("\nIf that works, teammates should use the 'device code' link on the")
            print("sign-in screen, and browser sign-in is not viable on these machines.\n")
        return 1

    claims = _decode_claims(token.token)
    print("\nSUCCESS")
    print(f"  signed in as : {claims.get('name')} <{claims.get('upn') or claims.get('preferred_username')}>")
    print(f"  token expires: {token.expires_on}")
    print(f"\n{method} sign-in works on this machine.")
    if not args.device:
        print("The Sign in button will work for teammates. Nothing further to do.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
