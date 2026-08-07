"""Official Python client for the ghfind API (https://ghfind.com).

Every method is an atomic capability backed by one public endpoint. Scoring
(``scan``, ``score``, ``get_score``, the ``vs`` winner) is deterministic and never
calls an LLM. Only ``roast``/``vs`` *prose* uses an LLM, and ``roast`` accepts a
bring-your-own key so you can run it through your own model.

Zero runtime dependencies (standard-library ``urllib``). A ``transport`` callable
can be injected for testing or non-standard runtimes.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Dict, List, Optional, Tuple, Union

from .types import ByoKey, RoastResult, ScanResult, ScorePayload, Scoring

DEFAULT_HOST = "https://ghfind.com"
_GITHUB_API = "https://api.github.com"
_ROAST_META_HEADER = "x-roast-meta"
_FRAME = "\x1f"
_SCAN_JOB_TIMEOUT_SECONDS = 75.0
_SCAN_JOB_POLL_SECONDS = 1.0

# transport(method, url, headers, body) -> (status, text, response_headers)
Transport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, str, Dict[str, str]]]


class GhFindError(Exception):
    """Raised for any non-2xx API response (and roast-stream errors)."""

    def __init__(self, message: str, *, status: Optional[int] = None,
                 code: Optional[str] = None, body: object = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


def _urllib_transport(method: str, url: str, headers: Dict[str, str],
                      body: Optional[bytes]) -> Tuple[int, str, Dict[str, str]]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            text = resp.read().decode("utf-8", "replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, text, resp_headers
    except urllib.error.HTTPError as e:  # non-2xx still carries a body
        text = e.read().decode("utf-8", "replace") if e.fp else ""
        resp_headers = {k.lower(): v for k, v in (e.headers or {}).items()}
        return e.code, text, resp_headers


def _decode_meta(value: Optional[str]) -> Optional[dict]:
    if not value:
        return None
    try:
        return json.loads(base64.b64decode(value).decode("utf-8"))
    except Exception:
        return None


class GhFind:
    def __init__(
        self,
        host: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        turnstile_token: Optional[str] = None,
        github_token: Optional[str] = None,
        transport: Optional[Transport] = None,
    ) -> None:
        raw = (host or os.environ.get("GHFIND_HOST") or os.environ.get("GITHUB_ROAST_HOST") or DEFAULT_HOST).strip()
        self.host = raw.rstrip("/")
        self._api_key = api_key
        self._turnstile_token = turnstile_token
        self._github_token = github_token
        self._transport = transport or _urllib_transport

    # ---- low-level -----------------------------------------------------------

    def _auth_headers(self) -> Dict[str, str]:
        return {"authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    def _raise(self, status: int, text: str) -> None:
        parsed: object = None
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = text
        code = parsed.get("error") if isinstance(parsed, dict) else None
        msg = f"API request failed: {code}" if code else f"API request failed with HTTP {status}"
        raise GhFindError(msg, status=status, code=code, body=parsed)

    def _get(self, path: str) -> Tuple[str, Dict[str, str]]:
        status, text, headers = self._transport("GET", f"{self.host}{path}", {}, None)
        if not 200 <= status < 300:
            self._raise(status, text)
        return text, headers

    def _get_json(self, path: str) -> dict:
        text, _ = self._get(path)
        return json.loads(text)

    def _post(self, path: str, body: dict) -> Tuple[int, str, Dict[str, str]]:
        headers = {"content-type": "application/json", **self._auth_headers()}
        data = json.dumps(body).encode("utf-8")
        return self._transport("POST", f"{self.host}{path}", headers, data)

    def _post_json(self, path: str, body: dict) -> dict:
        status, text, _ = self._post(path, body)
        if not 200 <= status < 300:
            self._raise(status, text)
        return json.loads(text)

    def _absolute_url(self, location: str) -> str:
        return urllib.parse.urljoin(self.host + "/", location)

    def _poll_scan_job(self, location: str) -> ScanResult:
        deadline = time.monotonic() + _SCAN_JOB_TIMEOUT_SECONDS
        last: object = None
        while True:
            status, text, _ = self._transport("GET", self._absolute_url(location), {}, None)
            if not 200 <= status < 300:
                self._raise(status, text)
            payload = json.loads(text) if text else {}
            last = payload
            if isinstance(payload, dict) and payload.get("result"):
                return payload["result"]  # type: ignore[return-value]
            job = payload.get("status") if isinstance(payload, dict) else None
            if isinstance(job, dict) and job.get("state") == "failed":
                raise GhFindError("Scan job failed", status=status,
                                  code=job.get("error") or "scan_failed", body=payload)
            if time.monotonic() >= deadline:
                raise GhFindError("Scan job timed out", status=202,
                                  code="scan_timeout", body=last)
            time.sleep(_SCAN_JOB_POLL_SECONDS)

    # ---- GitHub existence check (client-side; does NOT touch ghfind) ----------

    def get_github_user(self, username: str, *, token: Optional[str] = None) -> Optional[dict]:
        """Look up a GitHub account directly from GitHub's public API.

        Returns the basic public profile, or ``None`` if the login does not exist
        (HTTP 404). Runs on the caller's IP/quota, not ghfind's — confirm an
        account is real before spending a call on scoring. No token needed; pass
        one to raise GitHub's ~60/h anon limit to 5000/h. Raises ``GhFindError``
        (code ``github_rate_limited``) if GitHub throttles the check, so a
        throttle is never mistaken for "not found".
        """
        tok = token or self._github_token
        headers = {"accept": "application/vnd.github+json"}
        if tok:
            headers["authorization"] = f"Bearer {tok}"
        status, text, _ = self._transport(
            "GET", f"{_GITHUB_API}/users/{urllib.parse.quote(username)}", headers, None
        )
        if status == 404:
            return None
        if status in (403, 429):
            raise GhFindError("GitHub rate-limited the existence check",
                              status=status, code="github_rate_limited")
        if not 200 <= status < 300:
            self._raise(status, text)
        return json.loads(text)

    def user_exists(self, username: str, *, token: Optional[str] = None) -> bool:
        """Convenience boolean form of :meth:`get_github_user`."""
        return self.get_github_user(username, token=token) is not None

    def _ensure_exists(self, username: str, token: Optional[str]) -> None:
        if self.get_github_user(username, token=token) is None:
            raise GhFindError(f'GitHub user "{username}" does not exist',
                              status=404, code="github_user_not_found")

    # ---- Scoring (deterministic, no LLM) -------------------------------------

    def scan(self, username: str, *, verify_exists: bool = False,
             github_token: Optional[str] = None) -> ScanResult:
        """Crawl GitHub and compute the full deterministic scan + score.

        Pass ``verify_exists=True`` to confirm the account is real via the
        client-side GitHub check first, so a typo/nonexistent handle fails fast
        without hitting ghfind at all.
        """
        if verify_exists:
            self._ensure_exists(username, github_token)
        body: dict = {"username": username}
        if self._turnstile_token:
            body["turnstileToken"] = self._turnstile_token
        status, text, headers = self._post("/api/scan", body)
        if not 200 <= status < 300:
            self._raise(status, text)
        if status == 202:
            location = headers.get("location") or headers.get("Location")
            if not location:
                raise GhFindError("Scan job accepted without a status Location",
                                  status=202, code="scan_status_missing")
            return self._poll_scan_job(location)
        return json.loads(text)  # type: ignore[return-value]

    def score(self, username: str, *, verify_exists: bool = False,
              github_token: Optional[str] = None) -> Scoring:
        """Just the ``scoring`` block of a fresh scan."""
        return self.scan(username, verify_exists=verify_exists,
                         github_token=github_token)["scoring"]  # type: ignore[index]

    def get_score(self, username: str, *, verify_exists: bool = False,
                  github_token: Optional[str] = None) -> ScorePayload:
        """Deterministic score via ``GET /api/score/{username}`` (no LLM).

        Indexed accounts return the stored payload (``source == "indexed"``, with
        tags/roast_line); unseen accounts are admitted to the Go quick-scan
        worker path (``source == "quick"``, includes red_flags). A compatible old
        stored score may return ``source == "legacy_v5_v5_v3"`` with
        ``stale == True``. Raises ``GhFindError`` with status 404 only when the
        GitHub login does not exist. Cheapest way to get a score.

        Pass ``verify_exists=True`` to confirm the account is real (client-side
        GitHub check) before calling ghfind — avoids triggering a live
        worker work for a handle that doesn't exist.
        """
        if verify_exists:
            self._ensure_exists(username, github_token)
        return self._get_json(f"/api/score/{urllib.parse.quote(username)}")  # type: ignore[return-value]

    # ---- Roast (LLM; bring-your-own key supported) ---------------------------

    def roast(
        self,
        username: Optional[str] = None,
        *,
        scan: Optional[ScanResult] = None,
        lang: Optional[str] = None,
        byo_key: Optional[ByoKey] = None,
    ) -> RoastResult:
        """Generate the human-facing roast report + AI-adjusted score.

        Pass ``scan`` to reuse one you already have, otherwise a fresh scan is run
        first. Pass ``byo_key`` to use your own OpenAI-compatible provider.
        """
        if scan is None:
            if not username:
                raise GhFindError("roast requires a username or a scan")
            scan = self.scan(username)
        body: dict = {"scan": scan}
        if lang:
            body["lang"] = lang
        if byo_key:
            body["byoKey"] = byo_key
        status, text, headers = self._post("/api/roast", body)
        if not 200 <= status < 300:
            self._raise(status, text)
        return self._parse_roast_stream(status, text, headers)

    @staticmethod
    def _parse_roast_stream(status: int, text: str, headers: Dict[str, str]) -> RoastResult:
        meta = _decode_meta(headers.get(_ROAST_META_HEADER))
        report_lines: List[str] = []
        progress: List[str] = []
        for line in text.split("\n"):
            if line.startswith(_FRAME + "T"):
                progress.append(line[2:])
            elif line.startswith(_FRAME + "M"):
                meta = _decode_meta(line[2:]) or meta
            elif line.startswith(_FRAME + "E"):
                raw = line[2:]
                try:
                    parsed: object = json.loads(raw)
                except ValueError:
                    parsed = raw
                code = parsed.get("error") if isinstance(parsed, dict) else None
                raise GhFindError("Roast stream failed", status=status, code=code, body=parsed)
            else:
                report_lines.append(line)
        return {"meta": meta, "report": "\n".join(report_lines).strip("\n"), "progress": progress}

    # ---- Battle / PK ---------------------------------------------------------

    def vs(self, a: str, b: str) -> dict:
        """Head-to-head verdict for two scored accounts (winner deterministic)."""
        return self._post_json("/api/vs-verdict", {"a": a, "b": b})

    # ---- Discovery (deterministic, no LLM) -----------------------------------

    def leaderboard(self, view: Optional[str] = None, window: Optional[str] = None) -> dict:
        params = {k: v for k, v in {"view": view, "window": window}.items() if v}
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._get_json(f"/api/leaderboard{qs}")

    def developers(self, type: str, value: Optional[str] = None) -> dict:
        params = {"type": type}
        if value:
            params["value"] = value
        return self._get_json(f"/api/developers?{urllib.parse.urlencode(params)}")

    def search_users(self, q: str) -> dict:
        return self._get_json(f"/api/search-users?{urllib.parse.urlencode({'q': q})}")

    def stats(self) -> dict:
        return self._get_json("/api/stats")

    # ---- Image URL builders (pure, no request) -------------------------------

    def badge_url(self, username: str, lang: Optional[str] = None) -> str:
        q = f"?lang={lang}" if lang else ""
        return f"{self.host}/api/badge/{urllib.parse.quote(username)}{q}"

    def card_url(self, username: str) -> str:
        return f"{self.host}/api/card/{urllib.parse.quote(username)}"

    def vs_card_url(self, a: str, b: str) -> str:
        return f"{self.host}/api/card/vs/{urllib.parse.quote(a)}/{urllib.parse.quote(b)}"
