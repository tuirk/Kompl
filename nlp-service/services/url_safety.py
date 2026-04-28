"""SSRF protection for outbound HTTP requests from nlp-service.

validate_outbound_url(url) returns a ValidatedURL with an IP-pinned URL plus
the host_header and sni_hostname needed to preserve HTTP routing and TLS
certificate validation.

Raises ValueError on any of:
  - Scheme not in {http, https}
  - Empty/missing host
  - Host in cloud-metadata blocklist
  - DNS resolution failure
  - Any returned IP is private/loopback/link-local/multicast/reserved/unspecified

The caller MUST pass the returned pinned_url to httpx with the Host header and
the `sni_hostname` request extension. This eliminates the validate-then-fetch
DNS-rebind TOCTOU window: httpx connects directly to the validated IP, never
re-resolves DNS, and TLS SNI/cert validation still target the original hostname.

For each redirect hop, re-call validate_outbound_url on the Location URL.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import NamedTuple
from urllib.parse import urlparse

_ALLOWED_SCHEMES = frozenset({"http", "https"})
_BLOCKED_HOSTS = frozenset({
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.local",
})


class ValidatedURL(NamedTuple):
    pinned_url: str
    host_header: str
    sni_hostname: str


def _check_ip_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        raise ValueError("private_address")


def validate_outbound_url(url: str) -> ValidatedURL:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise ValueError("scheme_not_allowed")

    host = parsed.hostname
    if not host:
        raise ValueError("missing_host")

    if host.lower() in _BLOCKED_HOSTS:
        raise ValueError("host_blocked")

    try:
        direct_ip = ipaddress.ip_address(host)
    except ValueError:
        direct_ip = None

    if direct_ip is not None:
        _check_ip_public(direct_ip)
        pinned_ip = str(direct_ip)
    else:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise ValueError("dns_failure") from e

        if not infos:
            raise ValueError("dns_no_results")

        pinned_ip = None
        for _family, _type, _proto, _canonname, sockaddr in infos:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError as e:
                raise ValueError("invalid_ip") from e
            _check_ip_public(ip)
            if pinned_ip is None:
                pinned_ip = ip_str

        if pinned_ip is None:
            raise ValueError("dns_no_results")

    netloc_ip = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
    if parsed.port:
        netloc_ip = f"{netloc_ip}:{parsed.port}"

    host_header = host if not parsed.port else f"{host}:{parsed.port}"
    pinned_url = parsed._replace(netloc=netloc_ip).geturl()

    return ValidatedURL(
        pinned_url=pinned_url,
        host_header=host_header,
        sni_hostname=host,
    )
