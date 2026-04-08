"""Thin httpx wrapper shared across nlp-service routers.

Commit 3: used by routers/conversion.py for the Firecrawl call only.
Later commits will reuse it for any additional outbound HTTP (e.g. Gemini via
services/llm_client.py in commit 9, any other external dependency that lands).

Design notes:
- One short-lived `httpx.Client` per call. No connection pooling. We do not
  expect enough outbound throughput in commit 3 to need a long-lived client,
  and short-lived clients keep error handling and lifecycle simple.
- Manual retry loop with exponential backoff (1s → 2s → 4s) because httpx has
  no built-in retry. See docs/research/2026-04-08-conversion-deps.md section 4.
- On final failure, raises a custom HttpClientError so callers can distinguish
  network/timeout/5xx/4xx classes of failure when translating to HTTP errors
  per the contract (docs/contracts.md contract 2a).
"""

from __future__ import annotations

import time

import httpx


class HttpClientError(Exception):
    """Raised by HttpClient.post_json on final failure.

    Attributes:
        message: Human-readable description.
        status_code: HTTP status code from the upstream response, or None for
            network/timeout errors where no response was received.
        upstream_body: Raw body text from the upstream response, or None.
    """

    def __init__(
        self,
        message: str,
        status_code: int | None,
        upstream_body: str | None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.upstream_body = upstream_body


class HttpClient:
    def __init__(self, timeout: float = 30.0, max_retries: int = 3) -> None:
        self.timeout = timeout
        self.max_retries = max_retries

    def post_json(
        self,
        url: str,
        json_body: dict,
        headers: dict | None = None,
    ) -> dict:
        """POST JSON to `url` and return the parsed JSON response.

        Retries up to `max_retries` times with exponential backoff on:
          - httpx.RequestError (network/timeout)
          - httpx.HTTPStatusError where status_code >= 500

        Does NOT retry on 4xx. Raises HttpClientError on final failure.
        """
        last_status: int | None = None
        last_body: str | None = None
        last_message: str = ""

        for attempt in range(self.max_retries):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.post(url, json=json_body, headers=headers)
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as e:
                last_status = e.response.status_code
                last_body = e.response.text
                last_message = f"HTTP {last_status} from {url}"
                if last_status < 500:
                    # Do not retry 4xx — the caller's request is at fault.
                    raise HttpClientError(
                        message=last_message,
                        status_code=last_status,
                        upstream_body=last_body,
                    ) from e
            except httpx.RequestError as e:
                last_status = None
                last_body = None
                last_message = f"network error calling {url}: {e!r}"

            if attempt < self.max_retries - 1:
                # Exponential backoff: 1s, 2s, 4s
                time.sleep(2 ** attempt)

        raise HttpClientError(
            message=last_message,
            status_code=last_status,
            upstream_body=last_body,
        )
