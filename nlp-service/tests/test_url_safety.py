"""Tests for services/url_safety.validate_outbound_url."""

from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

from services.url_safety import ValidatedURL, validate_outbound_url


def _gai(*ip_strs: str):
    """Build a mock socket.getaddrinfo return value for the given IPs."""
    out = []
    for ip in ip_strs:
        if ":" in ip:
            out.append((socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, 443, 0, 0)))
        else:
            out.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)))
    return out


def test_allows_public_https_and_pins_ip():
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai("1.1.1.1")):
        result = validate_outbound_url("https://example.com/path")
    assert result == ValidatedURL(
        pinned_url="https://1.1.1.1/path",
        host_header="example.com",
        sni_hostname="example.com",
    )


def test_allows_public_http_and_pins_ip():
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai("8.8.8.8")):
        result = validate_outbound_url("http://example.com/")
    assert result.pinned_url == "http://8.8.8.8/"
    assert result.host_header == "example.com"
    assert result.sni_hostname == "example.com"


def test_preserves_port_in_pinned_url_and_host_header():
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai("1.1.1.1")):
        result = validate_outbound_url("https://example.com:8443/x")
    assert result.pinned_url == "https://1.1.1.1:8443/x"
    assert result.host_header == "example.com:8443"


def test_preserves_query_and_fragment():
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai("1.1.1.1")):
        result = validate_outbound_url("https://example.com/p?q=1&r=2#frag")
    assert result.pinned_url == "https://1.1.1.1/p?q=1&r=2#frag"


def test_brackets_ipv6_in_pinned_url():
    with patch(
        "services.url_safety.socket.getaddrinfo",
        return_value=_gai("2606:4700:4700::1111"),
    ):
        result = validate_outbound_url("https://example.com/")
    assert result.pinned_url == "https://[2606:4700:4700::1111]/"


def test_accepts_user_supplied_public_ip_directly():
    """When user provides a literal IP, no DNS lookup happens but validation still runs."""
    result = validate_outbound_url("http://1.1.1.1/path")
    assert result.pinned_url == "http://1.1.1.1/path"
    assert result.host_header == "1.1.1.1"
    assert result.sni_hostname == "1.1.1.1"


def test_rejects_user_supplied_private_ip_directly():
    with pytest.raises(ValueError, match="private_address"):
        validate_outbound_url("http://10.0.0.1/")


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "gopher://example.com/",
    "dict://example.com:11211/",
    "ftp://example.com/",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
])
def test_rejects_non_http_schemes(url):
    with pytest.raises(ValueError, match="scheme_not_allowed"):
        validate_outbound_url(url)


def test_rejects_empty_host():
    with pytest.raises(ValueError, match="missing_host"):
        validate_outbound_url("http:///path")


@pytest.mark.parametrize("host", [
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.local",
    "Metadata.Google.Internal",
])
def test_rejects_cloud_metadata_hostnames(host):
    with pytest.raises(ValueError, match="host_blocked"):
        validate_outbound_url(f"http://{host}/computeMetadata/v1/")


@pytest.mark.parametrize("ip", [
    "127.0.0.1",
    "127.0.0.53",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
])
def test_rejects_private_loopback_link_local_multicast_reserved_ipv4(ip):
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai(ip)):
        with pytest.raises(ValueError, match="private_address"):
            validate_outbound_url("http://target.test/")


@pytest.mark.parametrize("ip", [
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff00::1",
])
def test_rejects_private_loopback_link_local_ipv6(ip):
    with patch("services.url_safety.socket.getaddrinfo", return_value=_gai(ip)):
        with pytest.raises(ValueError, match="private_address"):
            validate_outbound_url("http://target.test/")


def test_rejects_dns_failure():
    with patch("services.url_safety.socket.getaddrinfo", side_effect=socket.gaierror("nodns")):
        with pytest.raises(ValueError, match="dns_failure"):
            validate_outbound_url("http://nonexistent-domain.test")


def test_rejects_dns_no_results():
    with patch("services.url_safety.socket.getaddrinfo", return_value=[]):
        with pytest.raises(ValueError, match="dns_no_results"):
            validate_outbound_url("http://target.test")


def test_rejects_when_any_ip_in_dns_response_is_private():
    with patch(
        "services.url_safety.socket.getaddrinfo",
        return_value=_gai("1.1.1.1", "10.0.0.1"),
    ):
        with pytest.raises(ValueError, match="private_address"):
            validate_outbound_url("https://multi.test")


def test_pins_first_returned_ip():
    """When DNS returns multiple public IPs, pin the first one."""
    with patch(
        "services.url_safety.socket.getaddrinfo",
        return_value=_gai("1.1.1.1", "8.8.8.8"),
    ):
        result = validate_outbound_url("https://multi.test/")
    assert result.pinned_url == "https://1.1.1.1/"
