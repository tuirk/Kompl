"""Refuse requests that name this service by a host Kompl doesn't use.

nlp-service has no login and is published on 127.0.0.1:8000. After DNS
rebinding (a hostile page's name re-pointed at 127.0.0.1) the browser treats
that page as same-origin with the service, so it could call /pipeline/*,
which spends model money, or /storage/write-file, which writes under /data,
kompl.db included. Such a request still carries the hostile name in its Host
header. Kompl's own callers use the compose service name (the app calls
http://nlp-service:8000), localhost or an IP address, and no outside DNS
controls any of those. The same names as the app's proxy.ts pass, plus those
in KOMPL_ALLOWED_HOSTS.
"""

from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

_SERVICE_NAMES = frozenset({"app", "nlp-service", "n8n"})


def _hostname(host: str) -> str | None:
    """The lower-cased name of "host[:port]", or None when it isn't one."""
    try:
        return urlsplit(f"//{host}").hostname or None
    except ValueError:
        return None


def is_known_host(host: str | None) -> bool:
    """localhost and its subdomains, IP addresses, Kompl's service names, and
    the names in KOMPL_ALLOWED_HOSTS. A request without a Host header doesn't
    come from a browser and passes."""
    if host is None:
        return True
    name = _hostname(host)
    if not name:
        return False
    if name == "localhost" or name.endswith(".localhost") or name in _SERVICE_NAMES:
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    extra = os.environ.get("KOMPL_ALLOWED_HOSTS", "").split(",")
    return name in {_hostname(h.strip()) for h in extra if h.strip()}


class KnownHostMiddleware:
    """Answers 403 before any route when the Host header isn't a known one."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            raw = dict(scope["headers"]).get(b"host")
            if not is_known_host(raw.decode("latin-1") if raw is not None else None):
                response = JSONResponse(
                    {"detail": "unknown_host: nlp-service answers only to Kompl's own host names"},
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
