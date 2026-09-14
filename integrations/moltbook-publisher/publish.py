#!/usr/bin/env python3
"""Deterministic, bounded Moltbook publisher for engine COMMENT actions."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


OFFICIAL_ORIGIN = "https://www.moltbook.com"
API_BASE = f"{OFFICIAL_ORIGIN}/api/v1"
DEFAULT_CONFIG = Path.home() / ".hermes" / "data" / "moltbook-publisher.json"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
SAFE_ENV = re.compile(r"^[A-Z][A-Z0-9_]*$")
DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_MAX_COMMENT_PAGES = 10
ATTEMPT_STATUSES = {"reserved", "receipt_saved", "imported"}
RECEIPT_STATUSES = {"PUBLISHED", "FAILED", "VERIFICATION_REQUIRED", "RECONCILIATION_REQUIRED"}


class PublisherError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: urllib.request.Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise PublisherError("redirect refused")


def canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def stable_json(value: Any) -> str:
    return json.dumps(canonical(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def comment_hash(value: str) -> str:
    return sha256_text(normalize_text(value))


def sign_contract_value(value: Any, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), stable_json(value).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_contract_signature(value: dict[str, Any], key_id: str, secret: str, label: str) -> None:
    if value.get("signatureKeyId") != key_id or not isinstance(value.get("signature"), str):
        raise PublisherError(f"{label} contract signature is missing or uses an unapproved key")
    unsigned = dict(value)
    unsigned.pop("signatureKeyId", None)
    unsigned.pop("signature", None)
    unsigned.pop("receiptHash", None)
    if not hmac.compare_digest(str(value["signature"]), sign_contract_value(unsigned, secret)):
        raise PublisherError(f"{label} contract signature is invalid")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublisherError(f"publisher config unavailable: {type(exc).__name__}") from exc
    if not isinstance(value, dict):
        raise PublisherError("publisher config must be an object")
    required = {"account", "project_dir", "pending_dir", "handoff_dir", "contract_key_id"}
    missing = sorted(required - value.keys())
    if missing:
        raise PublisherError(f"publisher config missing: {','.join(missing)}")
    for key in required:
        if not isinstance(value[key], str) or not value[key].strip():
            raise PublisherError(f"publisher config field is invalid: {key}")
    for key in ("max_actions_per_cycle", "daily_comment_cap", "request_timeout_seconds", "max_comment_pages", "max_response_bytes"):
        if key in value and (not isinstance(value[key], int) or value[key] < 1):
            raise PublisherError(f"publisher config field is invalid: {key}")
    for provider_key in ("secret_provider", "contract_secret_provider"):
        provider = value.get(provider_key, "macos-keychain")
        if provider not in ("macos-keychain", "environment"):
            raise PublisherError(f"publisher config field is invalid: {provider_key}")
    if value.get("secret_provider", "macos-keychain") == "environment":
        environment_key = value.get("api_key_environment_variable", "MOLTBOOK_API_KEY")
        if not isinstance(environment_key, str) or not SAFE_ENV.fullmatch(environment_key):
            raise PublisherError("publisher api key environment variable is invalid")
    elif any(key not in value for key in ("credential_service", "credential_account")):
        raise PublisherError("publisher config is missing Keychain credential reference")
    if value.get("contract_secret_provider", "macos-keychain") == "environment":
        environment_key = value.get("contract_secret_environment_variable", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET")
        if not isinstance(environment_key, str) or not SAFE_ENV.fullmatch(environment_key):
            raise PublisherError("publisher contract environment variable is invalid")
    elif any(key not in value for key in ("contract_keychain_service", "contract_keychain_account")):
        raise PublisherError("publisher config is missing contract Keychain reference")
    cooldown = value.get("comment_cooldown_seconds", 20)
    if not isinstance(cooldown, int) or cooldown < 20:
        raise PublisherError("comment_cooldown_seconds must be at least 20")
    if int(value.get("max_actions_per_cycle", 5)) > int(value.get("daily_comment_cap", 50)):
        raise PublisherError("max_actions_per_cycle exceeds daily_comment_cap")
    if int(value.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)) < 1024:
        raise PublisherError("max_response_bytes is too small")
    return value


def ensure_under(path: Path, root: Path) -> Path:
    resolved = path.expanduser().resolve()
    root_resolved = root.expanduser().resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise PublisherError("path escapes configured root")
    return resolved


def read_keychain(service: str, account: str) -> str:
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PublisherError("publisher Keychain credential unavailable") from exc
    secret = result.stdout.strip()
    if not secret:
        raise PublisherError("publisher Keychain credential is empty")
    return secret


def read_secret(
    config: dict[str, Any],
    key: str,
    environment_key: str,
    service_key: str,
    account_key: str,
    provider_key: str = "secret_provider",
) -> str:
    provider = config.get(provider_key, "macos-keychain")
    if provider == "environment":
        value = os.environ.get(environment_key, "").strip()
        if not value:
            raise PublisherError(f"publisher environment secret unavailable: {environment_key}")
        return value
    if provider != "macos-keychain":
        raise PublisherError(f"publisher secret provider is unsupported: {provider_key}")
    try:
        service = str(config[service_key])
        account = str(config[account_key])
    except KeyError as exc:
        raise PublisherError(f"publisher Keychain reference is missing: {key}") from exc
    return read_keychain(service, account)


def is_official_post_url(value: str, post_id: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme == "https" and parsed.netloc == "www.moltbook.com" and parsed.path == f"/post/{urllib.parse.quote(post_id, safe='')}"


def validate_action(action: dict[str, Any], config: dict[str, Any]) -> None:
    if action.get("schema_version") != "1.0" or action.get("action") != "COMMENT" or action.get("platform") != "moltbook":
        raise PublisherError("request action must be a v1 Moltbook COMMENT")
    action_id = action.get("action_id")
    if not isinstance(action_id, str) or not SAFE_ID.fullmatch(action_id):
        raise PublisherError("request action_id is invalid")
    target = action.get("target")
    content = action.get("content")
    if not isinstance(target, dict) or not isinstance(content, dict):
        raise PublisherError("request target/content is invalid")
    post_id = target.get("post_id")
    post_url = target.get("post_url")
    comment = content.get("comment")
    if not isinstance(post_id, str) or not post_id or not SAFE_ID.fullmatch(post_id):
        raise PublisherError("request post_id is invalid")
    if not isinstance(post_url, str) or not is_official_post_url(post_url, post_id):
        raise PublisherError("request post_url is not an official Moltbook URL")
    if not isinstance(comment, str) or not comment.strip() or len(comment) > 40000:
        raise PublisherError("request comment is invalid")
    if len(re.findall(r"\bmarx\b", comment, flags=re.IGNORECASE)) < 1:
        raise PublisherError("request comment has no Marx mention")
    expected = {"commentHash": comment_hash(comment), "postId": post_id, "strategyFamily": content.get("strategy_family")}
    # The engine's deterministicId hashes its variadic parts as an array.
    expected_action_id = "act_" + sha256_text(stable_json([expected]))[:32]
    if expected_action_id != action_id:
        raise PublisherError("request action_id hash mismatch")
    allow = config.get("allowed_domains", ["www.moltbook.com"])
    if not isinstance(allow, list) or set(allow) != {"www.moltbook.com"}:
        raise PublisherError("publisher allowlist must be exactly www.moltbook.com")


def verify_request(request: dict[str, Any], config: dict[str, Any], now: datetime, contract_secret: str) -> dict[str, Any]:
    if request.get("schemaVersion") != "1.0" or request.get("messageType") != "MOLTBOOK_ACTION_REQUEST":
        raise PublisherError("request envelope is invalid")
    if request.get("publisherAccount") != config["account"] or request.get("platform") != "moltbook":
        raise PublisherError("request publisher account/platform mismatch")
    grant = request.get("grant")
    if not isinstance(grant, dict) or grant.get("publisherAccount") != config["account"]:
        raise PublisherError("request grant is not bound to publisher account")
    if grant.get("maxActions") != 1 or grant.get("allowedActionIds") != [request.get("actionId")]:
        raise PublisherError("request grant is not bounded to exactly one action")
    verify_contract_signature(grant, str(config["contract_key_id"]), contract_secret, "grant")
    try:
        grant_valid = parse_time(str(grant["issuedAt"])) <= now < parse_time(str(grant["expiresAt"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise PublisherError("request grant timestamps are invalid") from exc
    if not grant_valid:
        raise PublisherError("request grant is not currently valid")
    action = request.get("action")
    if not isinstance(action, dict):
        raise PublisherError("request action is missing")
    validate_action(action, config)
    if request.get("actionId") != action.get("action_id") or action.get("action_id") not in grant.get("allowedActionIds", []):
        raise PublisherError("request action is not authorized by grant")
    if request.get("actionHash") != sha256_text(stable_json(action)):
        raise PublisherError("request actionHash mismatch")
    target = action["target"]
    comment = action["content"]["comment"]
    if request.get("contentHash") != comment_hash(comment) or request.get("bodyHash") != sha256_text(comment):
        raise PublisherError("request content/body hash mismatch")
    if request.get("targetHash") != sha256_text(stable_json(target)):
        raise PublisherError("request targetHash mismatch")
    material = dict(request)
    material.pop("requestHash", None)
    if request.get("requestHash") != sha256_text(stable_json(material)):
        raise PublisherError("request requestHash mismatch")
    return action


def make_grant(action_id: str, account: str, now: datetime, key_id: str, secret: str) -> dict[str, Any]:
    grant = {
        "schemaVersion": "1.0",
        "grantId": f"hermes-grant-{uuid.uuid4().hex}",
        "publisherAccount": account,
        "allowedActionIds": [action_id],
        "maxActions": 1,
        "issuedAt": iso(now - timedelta(seconds=1)),
        "expiresAt": iso(now + timedelta(minutes=15)),
        "purpose": "bounded-moltbook-comment-publication",
        "issuedBy": "hermes-moltbook-publisher",
    }
    grant["signatureKeyId"] = key_id
    grant_material = dict(grant)
    grant_material.pop("signatureKeyId", None)
    grant["signature"] = sign_contract_value(grant_material, secret)
    return grant


def run_engine(project: Path, args: list[str], timeout: int, config: dict[str, Any] | None = None) -> dict[str, Any]:
    node = os.environ.get("MARX_GROWTH_NODE", "node")
    cli = project / "dist" / "cli" / "main.js"
    if not cli.is_file():
        raise PublisherError("engine build is missing dist/cli/main.js")
    configured_environment_keys = {
        str(config.get("api_key_environment_variable", "MOLTBOOK_API_KEY")) if config else "MOLTBOOK_API_KEY",
        str(config.get("contract_secret_environment_variable", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET")) if config else "MOLTBOOK_PUBLISHER_CONTRACT_SECRET",
    }
    baseline_environment_keys = {"PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "MARX_GROWTH_CONFIG_DIR", "MARX_GROWTH_DB", "MARX_TRACKER_API_TOKEN"}
    environment_keys = baseline_environment_keys | configured_environment_keys
    env = {key: os.environ[key] for key in environment_keys if key in os.environ}
    env["PATH"] = ":".join([str(Path(node).parent), os.environ.get("PATH", "/usr/bin:/bin")])
    try:
        result = subprocess.run([node, str(cli), *args], cwd=project, env=env, check=True, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PublisherError("engine handoff command failed") from exc
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PublisherError("engine handoff returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise PublisherError("engine handoff returned a non-object")
    return value


def http_json(
    url: str,
    method: str,
    api_key: str,
    body: dict[str, Any] | None,
    timeout: int,
    max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "www.moltbook.com" or not parsed.path.startswith("/api/v1/"):
        raise PublisherError("refusing non-official Moltbook URL")
    data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise PublisherError("Moltbook provider response exceeded the configured size limit")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, PublisherError) as exc:
        raise PublisherError(f"Moltbook provider request failed: {type(exc).__name__}") from exc
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublisherError("Moltbook provider returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise PublisherError("Moltbook provider returned a non-object")
    return value


def flatten_comments(comments: list[Any], max_nodes: int = 10000) -> list[dict[str, Any]]:
    """Flatten provider replies without allowing attacker-controlled recursion."""
    result: list[dict[str, Any]] = []
    stack: list[tuple[Any, int]] = [(item, 0) for item in reversed(comments)]
    while stack:
        item, depth = stack.pop()
        if not isinstance(item, dict):
            continue
        if len(result) >= max_nodes:
            raise PublisherError("Moltbook comment history exceeded the bounded read limit")
        result.append(item)
        nested = item.get("replies")
        if isinstance(nested, list):
            if depth >= 100:
                raise PublisherError("Moltbook comment nesting exceeded the bounded read limit")
            stack.extend((child, depth + 1) for child in reversed(nested))
    return result


def _pagination_details(readback: dict[str, Any]) -> tuple[bool, str | None, str | None]:
    metadata = readback.get("pagination")
    if metadata is None:
        metadata = readback.get("meta")
    if metadata is not None and not isinstance(metadata, dict):
        raise PublisherError("Moltbook readback pagination metadata is invalid")
    details = metadata if isinstance(metadata, dict) else readback
    has_more_value: Any = None
    for key in ("has_more", "hasMore", "more"):
        if key in details:
            has_more_value = details[key]
            break
    next_cursor: str | None = None
    for key in ("next_cursor", "nextCursor", "cursor"):
        value = details.get(key)
        if value is not None:
            if not isinstance(value, str) or not value:
                raise PublisherError("Moltbook readback pagination cursor is invalid")
            next_cursor = value
            break
    next_url: str | None = None
    for key in ("next", "next_url", "nextUrl"):
        value = details.get(key)
        if value is not None:
            if not isinstance(value, str) or not value:
                raise PublisherError("Moltbook readback pagination URL is invalid")
            next_url = value
            break
    if has_more_value is None:
        # A full page without metadata is ambiguous. Never assume it was the
        # complete history because that could hide an existing exact comment.
        return False, next_cursor, next_url
    if not isinstance(has_more_value, bool):
        raise PublisherError("Moltbook readback pagination has_more is invalid")
    if has_more_value and not (next_cursor or next_url):
        raise PublisherError("Moltbook readback is partial without a continuation")
    return has_more_value, next_cursor, next_url


def exact_readback(
    post_id: str,
    comment_text: str,
    publisher_account: str,
    api_key: str,
    timeout: int,
    max_pages: int = DEFAULT_MAX_COMMENT_PAGES,
) -> str | None:
    if max_pages < 1:
        raise PublisherError("Moltbook readback page bound is invalid")
    base_url = f"{API_BASE}/posts/{urllib.parse.quote(post_id, safe='')}/comments?sort=new&limit=100"
    url = base_url
    visited: set[str] = set()
    for page_number in range(max_pages):
        if url in visited:
            raise PublisherError("Moltbook readback pagination repeated a page")
        visited.add(url)
        readback = http_json(url, "GET", api_key, None, timeout)
        comments = readback.get("comments")
        if not isinstance(comments, list):
            raise PublisherError("Moltbook readback did not contain comments")
        for item in flatten_comments(comments):
            if item.get("content") != comment_text:
                continue
            author = item.get("author")
            author_name = author.get("name") if isinstance(author, dict) else None
            if author_name != publisher_account:
                raise PublisherError("exact content exists under a different publisher account")
            if isinstance(item.get("id"), str) and item["id"]:
                return item["id"]
            raise PublisherError("exact publisher comment has no provider id")
        has_more, next_cursor, next_url = _pagination_details(readback)
        if not has_more:
            # If the provider omitted pagination metadata, a full page is
            # ambiguous and must not be treated as a complete prewrite read.
            if "pagination" not in readback and "meta" not in readback and len(comments) >= 100:
                raise PublisherError("Moltbook readback may be partial; pagination metadata is missing")
            return None
        if page_number + 1 >= max_pages:
            raise PublisherError("Moltbook readback exceeded the bounded page limit")
        if next_url:
            parsed = urllib.parse.urlparse(next_url)
            if parsed.scheme != "https" or parsed.netloc != "www.moltbook.com" or not parsed.path.startswith("/api/v1/"):
                raise PublisherError("Moltbook readback continuation is not official")
            url = next_url
        else:
            url = f"{base_url}&cursor={urllib.parse.quote(next_cursor or '', safe='')}"
    raise PublisherError("Moltbook readback exceeded the bounded page limit")


def readback_after_publish(
    post_id: str,
    comment_text: str,
    publisher_account: str,
    api_key: str,
    timeout: int,
    max_pages: int = DEFAULT_MAX_COMMENT_PAGES,
) -> str | None:
    # Moltbook can accept a comment before it becomes visible to the comments GET.
    # Poll briefly, then require reconciliation rather than risking a duplicate POST.
    # Moltbook's comment GET can lag the successful POST by several seconds.
    # Poll for a slightly longer, still bounded window before requiring
    # reconciliation; never issue a second POST for the same action.
    for attempt in range(6):
        comment_id = exact_readback(post_id, comment_text, publisher_account, api_key, timeout, max_pages)
        if comment_id:
            return comment_id
        if attempt < 5:
            time.sleep(2)
    return None


def make_receipt(request: dict[str, Any], status: str, error_code: str | None, error_message: str | None, comment_id: str | None, published: dict[str, str] | None, key_id: str, secret: str) -> dict[str, Any]:
    observed_at = iso(now_utc())
    receipt: dict[str, Any] = {
        "schemaVersion": "1.0",
        "messageType": "MOLTBOOK_PUBLICATION_RECEIPT",
        "receiptId": f"receipt-{uuid.uuid4().hex}",
        "requestId": request["requestId"],
        "requestHash": request["requestHash"],
        "actionId": request["actionId"],
        "actionHash": request["actionHash"],
        "idempotencyKey": request["idempotencyKey"],
        "contentHash": request["contentHash"],
        "bodyHash": request["bodyHash"],
        "targetHash": request["targetHash"],
        "status": status,
        "evidenceStatus": "verified" if status == "PUBLISHED" else "unverified",
        "publisherAccount": request["publisherAccount"],
        "targetPostId": request["action"]["target"]["post_id"],
        "observedAt": observed_at,
        "signatureKeyId": key_id,
    }
    if status == "PUBLISHED" and published:
        receipt.update({"providerCommentId": comment_id, "publishedAt": published["publishedAt"], "permalink": published["permalink"]})
    else:
        receipt.update({"errorCode": error_code or "PROVIDER_FAILURE", "errorMessage": error_message or "provider did not publish"})
    receipt_material = dict(receipt)
    receipt_material.pop("signatureKeyId", None)
    receipt["signature"] = sign_contract_value(receipt_material, secret)
    receipt["receiptHash"] = sha256_text(stable_json(receipt))
    return receipt


def contains_verification_marker(value: Any) -> bool:
    """Detect verification challenges wherever a provider nests them."""
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in {"verificationrequired", "requiresverification", "captcha", "challenge"} and bool(nested):
                return True
            if normalized == "verification" and nested is not None:
                return True
            if contains_verification_marker(nested):
                return True
    elif isinstance(value, list):
        return any(contains_verification_marker(item) for item in value)
    return False


def publish_one(
    action: dict[str, Any],
    request: dict[str, Any],
    api_key: str,
    timeout: int,
    key_id: str,
    contract_secret: str,
    before_post: Callable[[], None] | None = None,
    max_pages: int = DEFAULT_MAX_COMMENT_PAGES,
) -> dict[str, Any]:
    post_id = action["target"]["post_id"]
    comment_text = action["content"]["comment"]
    publisher_account = request["publisherAccount"]
    try:
        existing_comment_id = exact_readback(post_id, comment_text, publisher_account, api_key, timeout, max_pages)
    except PublisherError as exc:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PREWRITE_READBACK_FAILED", str(exc), None, None, key_id, contract_secret)
    if existing_comment_id:
        published_at = iso(now_utc())
        permalink = f"{OFFICIAL_ORIGIN}/post/{urllib.parse.quote(post_id, safe='')}#comment-{urllib.parse.quote(existing_comment_id, safe='')}"
        return make_receipt(request, "PUBLISHED", None, None, existing_comment_id, {"publishedAt": published_at, "permalink": permalink}, key_id, contract_secret)
    # Keep the kill-switch check as the final operation before the POST. The
    # caller may have waited for cooldown or performed other network reads.
    if before_post is not None:
        before_post()
    try:
        response = http_json(f"{API_BASE}/posts/{urllib.parse.quote(post_id, safe='')}/comments", "POST", api_key, {"content": comment_text}, timeout)
    except PublisherError as exc:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_REQUEST_FAILED", str(exc), None, None, key_id, contract_secret)
    if response.get("success") is not True:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_REJECTED", "provider did not report success", None, None, key_id, contract_secret)
    if contains_verification_marker(response):
        return make_receipt(request, "VERIFICATION_REQUIRED", "PLATFORM_VERIFICATION_REQUIRED", "provider requested verification", None, None, key_id, contract_secret)
    comment = response.get("comment")
    comment_id = comment.get("id") if isinstance(comment, dict) else None
    if not isinstance(comment_id, str) or not comment_id:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_COMMENT_ID_MISSING", "provider success did not include a comment id", None, None, key_id, contract_secret)
    try:
        readback_comment_id = readback_after_publish(post_id, comment_text, publisher_account, api_key, timeout, max_pages)
    except PublisherError as exc:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "READBACK_FAILED", str(exc), None, None, key_id, contract_secret)
    if not readback_comment_id:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "READBACK_MISMATCH", "exact provider comment was not found", None, None, key_id, contract_secret)
    # The POST response and the subsequent comments GET can expose different
    # provider IDs for the same accepted comment. The GET result is the
    # authoritative evidence because it proves exact body and publisher
    # account ownership; use that canonical ID for the receipt permalink.
    comment_id = readback_comment_id
    published_at = iso(now_utc())
    permalink = f"{OFFICIAL_ORIGIN}/post/{urllib.parse.quote(post_id, safe='')}#comment-{urllib.parse.quote(comment_id, safe='')}"
    return make_receipt(request, "PUBLISHED", None, None, comment_id, {"publishedAt": published_at, "permalink": permalink}, key_id, contract_secret)


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read_json_file(path: Path, max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES) -> Any:
    try:
        with path.open("rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError as exc:
        raise PublisherError(f"publisher file unavailable: {type(exc).__name__}") from exc
    if len(raw) > max_bytes:
        raise PublisherError("publisher file exceeded the configured size limit")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublisherError(f"publisher file is malformed: {type(exc).__name__}") from exc


def _state_today(state: dict[str, Any], today: str) -> tuple[int, int, str | None]:
    if state.get("date") != today:
        return 0, 0, None
    attempts = int(state.get("attempts", state.get("published", 0)))
    published = int(state.get("published", 0))
    if published > attempts:
        raise PublisherError("publisher state has more publications than attempts")
    last_attempt_at = state.get("lastAttemptAt")
    if last_attempt_at is not None:
        if not isinstance(last_attempt_at, str):
            raise PublisherError("publisher state lastAttemptAt is invalid")
        try:
            parse_time(last_attempt_at)
        except ValueError as exc:
            raise PublisherError("publisher state lastAttemptAt is invalid") from exc
    return attempts, published, last_attempt_at


def validate_attempt(value: Any, action_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PublisherError("publisher attempt is not an object")
    if value.get("schemaVersion") != "1.0" or value.get("actionId") != action_id:
        raise PublisherError("publisher attempt is not bound to the selected action")
    status = value.get("status")
    if status not in ATTEMPT_STATUSES:
        raise PublisherError("publisher attempt status is invalid")
    for key in ("reservedAt",):
        if not isinstance(value.get(key), str):
            raise PublisherError("publisher attempt timestamp is invalid")
        try:
            parse_time(value[key])
        except ValueError as exc:
            raise PublisherError("publisher attempt timestamp is invalid") from exc
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not SAFE_ID.fullmatch(request_id):
        raise PublisherError("publisher attempt request ID is invalid")
    if status in {"receipt_saved", "imported"}:
        if not isinstance(value.get("receiptId"), str) or not SAFE_ID.fullmatch(value["receiptId"]):
            raise PublisherError("publisher attempt receipt ID is invalid")
        if value.get("receiptStatus") not in RECEIPT_STATUSES:
            raise PublisherError("publisher attempt receipt status is invalid")
    if status == "imported" and not isinstance(value.get("importedAt"), str):
        raise PublisherError("publisher attempt importedAt is invalid")
    return value


def load_attempt(path: Path, action_id: str, max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES) -> dict[str, Any] | None:
    try:
        value = read_json_file(path, max_bytes)
    except PublisherError as exc:
        if not path.exists():
            return None
        raise PublisherError(f"publisher attempt is corrupt for {action_id}: {exc}") from exc
    return validate_attempt(value, action_id)


def validate_receipt_for_request(receipt: Any, request: dict[str, Any], key_id: str, secret: str) -> dict[str, Any]:
    if not isinstance(receipt, dict):
        raise PublisherError("publisher receipt is not an object")
    if receipt.get("schemaVersion") != "1.0" or receipt.get("messageType") != "MOLTBOOK_PUBLICATION_RECEIPT":
        raise PublisherError("publisher receipt envelope is invalid")
    if receipt.get("status") not in RECEIPT_STATUSES:
        raise PublisherError("publisher receipt status is invalid")
    for key in ("requestId", "requestHash", "actionId", "actionHash", "idempotencyKey", "contentHash", "bodyHash", "targetHash", "publisherAccount", "targetPostId"):
        if receipt.get(key) != request.get(key) and key not in {"targetPostId", "publisherAccount"}:
            raise PublisherError("publisher receipt is not bound to its request")
    if receipt.get("publisherAccount") != request.get("publisherAccount"):
        raise PublisherError("publisher receipt publisher account does not match its request")
    target = request.get("action", {}).get("target") if isinstance(request.get("action"), dict) else None
    if not isinstance(target, dict) or receipt.get("targetPostId") != target.get("post_id"):
        raise PublisherError("publisher receipt target post does not match its request")
    verify_contract_signature(receipt, key_id, secret, "receipt")
    unsigned_hash = dict(receipt)
    receipt_hash = unsigned_hash.pop("receiptHash", None)
    if not isinstance(receipt_hash, str) or receipt_hash != sha256_text(stable_json(unsigned_hash)):
        raise PublisherError("publisher receipt hash is invalid")
    if receipt["status"] == "PUBLISHED":
        if receipt.get("evidenceStatus") != "verified" or not all(isinstance(receipt.get(key), str) and receipt[key] for key in ("providerCommentId", "publishedAt", "permalink")):
            raise PublisherError("PUBLISHED receipt does not contain verified evidence")
        permalink = urllib.parse.urlparse(receipt["permalink"])
        if permalink.scheme != "https" or permalink.netloc != "www.moltbook.com":
            raise PublisherError("publisher receipt permalink is not official")
    elif not isinstance(receipt.get("errorCode"), str) or not receipt["errorCode"]:
        raise PublisherError("non-published receipt is missing an error code")
    return receipt


def load_request(path: Path, config: dict[str, Any], secret: str, max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES) -> tuple[dict[str, Any], dict[str, Any]]:
    value = read_json_file(path, max_bytes)
    if not isinstance(value, dict):
        raise PublisherError("prepared request is invalid")
    action = verify_request(value, config, now_utc(), secret)
    return value, action


def strict_claimed_identity(api_key: str, account: str, timeout: int) -> None:
    status = http_json(f"{API_BASE}/agents/status", "GET", api_key, None, timeout)
    if status.get("status") != "claimed":
        raise PublisherError("Moltbook publisher agent is not claimed")
    identity = http_json(f"{API_BASE}/agents/me", "GET", api_key, None, timeout)
    agent = identity.get("agent")
    if not isinstance(agent, dict) or agent.get("name") != account or agent.get("is_claimed") is not True:
        raise PublisherError("Moltbook /agents/me identity is not claimed or does not match configured account")


def assert_kill_cleared(project: Path, timeout: int, config: dict[str, Any]) -> None:
    kill_status = run_engine(project, ["ops", "kill-status"], timeout, config)
    if not isinstance(kill_status, dict) or kill_status.get("status") != "CLEARED":
        raise PublisherError("publisher-side kill switch is engaged")


def quarantine_pending(path: Path, reason: str) -> None:
    quarantine = path.parent.parent / "quarantine"
    quarantine.mkdir(parents=True, exist_ok=True)
    target = quarantine / f"{path.stem}.publisher-invalid-{uuid.uuid4().hex}.json"
    try:
        os.replace(path, target)
    except FileNotFoundError:
        return
    atomic_write(Path(f"{target}.error.json"), {"quarantinedAt": iso(now_utc()), "reason": reason[:500]})


def publisher_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise PublisherError("another publisher consumer already owns the lock") from exc
    return handle


def requested_action_ids(action_ids: set[str] | None) -> list[str]:
    if not action_ids:
        raise PublisherError("real publisher runs require one or more explicit --action-id values")
    selected = sorted(action_ids)
    if any(not isinstance(action_id, str) or not SAFE_ID.fullmatch(action_id) for action_id in selected):
        raise PublisherError("requested action ID is invalid")
    return selected


def collect_pending(
    pending: Path,
    config: dict[str, Any],
    selected: set[str] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read pending entries without changing the directory.

    The second return value contains read errors only for validate-only mode;
    production treats selected read errors as a blocking condition.
    """
    if not pending.exists():
        if selected:
            raise PublisherError("selected pending action directory is missing")
        return [], []
    if not pending.is_dir():
        raise PublisherError("configured pending path is not a directory")
    max_bytes = int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES))
    entries: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for path in sorted(pending.glob("*.json")):
        try:
            raw = read_json_file(path, max_bytes)
        except PublisherError as exc:
            if selected is not None and path.stem in selected:
                raise
            errors.append({"path": str(path), "status": "INVALID", "error": str(exc)})
            continue
        if not isinstance(raw, dict):
            if selected is None:
                errors.append({"path": str(path), "status": "INVALID", "error": "pending action is not an object"})
            elif path.stem in selected:
                raise PublisherError("selected pending action is not an object")
            continue
        action_id = raw.get("action_id")
        if selected is not None:
            if action_id in selected or path.stem in selected:
                entries.append({"path": path, "transport": raw})
        elif raw.get("action") == "COMMENT":
            entries.append({"path": path, "transport": raw})
    if selected is not None:
        by_id: dict[str, list[dict[str, Any]]] = {action_id: [] for action_id in selected}
        for entry in entries:
            action_id = entry["transport"].get("action_id")
            if action_id in by_id:
                by_id[action_id].append(entry)
            elif entry["path"].stem in by_id:
                by_id[entry["path"].stem].append(entry)
        duplicate = next((action_id for action_id, matches in by_id.items() if len(matches) > 1), None)
        if duplicate:
            raise PublisherError(f"selected action ID has multiple pending files: {duplicate}")
        missing = [action_id for action_id, matches in by_id.items() if not matches]
        if missing:
            raise PublisherError(f"selected action IDs are not present: {','.join(missing)}")
        entries = [by_id[action_id][0] for action_id in sorted(by_id)]
    return entries, errors


def validate_pending(config: dict[str, Any], action_ids: set[str] | None) -> list[dict[str, Any]]:
    project = Path(config["project_dir"]).expanduser().resolve()
    pending = ensure_under(Path(config["pending_dir"]), project)
    selected = None if action_ids is None else set(requested_action_ids(action_ids))
    entries, errors = collect_pending(pending, config, selected)
    results = list(errors)
    for entry in entries:
        transport = entry["transport"]
        try:
            validate_action(transport, config)
            results.append({"actionId": transport.get("action_id"), "status": "VALID"})
        except PublisherError as exc:
            results.append({"actionId": transport.get("action_id"), "status": "INVALID", "error": str(exc)})
    return results


def wait_for_cooldown(state: dict[str, Any], today: str, cooldown: int) -> None:
    if state.get("date") != today or not state.get("lastAttemptAt"):
        return
    try:
        elapsed = (now_utc() - parse_time(str(state["lastAttemptAt"]))).total_seconds()
    except ValueError as exc:
        raise PublisherError("publisher state lastAttemptAt is invalid") from exc
    if elapsed < 0:
        raise PublisherError("publisher state lastAttemptAt is in the future")
    if elapsed < cooldown:
        time.sleep(cooldown - elapsed)


def reserve_attempt(
    attempt_path: Path,
    state_path: Path,
    state: dict[str, Any],
    action_id: str,
    request: dict[str, Any],
    today: str,
) -> dict[str, Any]:
    reserved_at = iso(now_utc())
    next_state = dict(state)
    if next_state.get("date") != today:
        next_state = {"date": today, "attempts": 0, "published": 0}
    next_state["attempts"] = int(next_state.get("attempts", 0)) + 1
    next_state["published"] = int(next_state.get("published", 0))
    next_state["lastAttemptAt"] = reserved_at
    # Count the attempt before creating any provider request. If either write
    # fails, no POST is reached and the cap remains conservative.
    atomic_write(state_path, next_state)
    attempt = {
        "schemaVersion": "1.0",
        "actionId": action_id,
        "requestId": request["requestId"],
        "requestHash": request["requestHash"],
        "status": "reserved",
        "reservedAt": reserved_at,
        "updatedAt": reserved_at,
    }
    atomic_write(attempt_path, attempt)
    state.clear()
    state.update(next_state)
    return attempt


def persist_and_import_receipt(
    project: Path,
    config: dict[str, Any],
    requests: Path,
    receipts: Path,
    attempt_path: Path,
    attempt: dict[str, Any],
    request: dict[str, Any],
    receipt: dict[str, Any],
    state_path: Path,
    state: dict[str, Any],
    today: str,
    contract_key_id: str,
    contract_secret: str,
) -> dict[str, Any]:
    request_id = request["requestId"]
    receipt_path = receipts / f"{request_id}.json"
    if receipt_path.exists():
        existing = read_json_file(receipt_path, int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)))
        if not isinstance(existing, dict):
            raise PublisherError("existing publisher receipt is invalid")
        receipt = validate_receipt_for_request(existing, request, contract_key_id, contract_secret)
    else:
        validate_receipt_for_request(receipt, request, contract_key_id, contract_secret)
        atomic_write(receipt_path, receipt)
    saved = dict(attempt)
    saved.update({"status": "receipt_saved", "receiptId": receipt["receiptId"], "receiptStatus": receipt["status"], "updatedAt": iso(now_utc())})
    atomic_write(attempt_path, saved)
    imported = run_engine(project, ["handoff", "import-receipt", request_id, "--receipt", str(receipt_path)], int(config.get("request_timeout_seconds", 30)), config)
    disposition = imported.get("disposition") if isinstance(imported, dict) else None
    if not isinstance(disposition, str) or not disposition:
        raise PublisherError("engine receipt import returned no disposition")
    imported_attempt = dict(saved)
    imported_attempt.update({"status": "imported", "importedAt": iso(now_utc()), "importedDisposition": disposition, "updatedAt": iso(now_utc())})
    atomic_write(attempt_path, imported_attempt)
    if receipt["status"] == "PUBLISHED":
        next_state = dict(state)
        next_state["published"] = int(next_state.get("published", 0)) + 1
        atomic_write(state_path, next_state)
        state.clear()
        state.update(next_state)
    return {"actionId": request["actionId"], "status": receipt["status"], "receiptId": receipt["receiptId"], "imported": disposition}


def recover_existing_attempt(
    project: Path,
    config: dict[str, Any],
    entry: dict[str, Any],
    attempt: dict[str, Any],
    requests: Path,
    receipts: Path,
    attempt_path: Path,
    state_path: Path,
    state: dict[str, Any],
    today: str,
    contract_key_id: str,
    contract_secret: str,
) -> dict[str, Any]:
    request_id = attempt["requestId"]
    request_path = requests / f"{request_id}.json"
    if not request_path.is_file():
        raise PublisherError("reserved publisher attempt is ambiguous because its request is missing")
    request, action = load_request(request_path, config, contract_secret, int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)))
    if action.get("action_id") != entry["transport"].get("action_id"):
        raise PublisherError("publisher attempt request is bound to a different pending action")
    receipt_path = receipts / f"{request_id}.json"
    if receipt_path.is_file():
        receipt_value = read_json_file(receipt_path, int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)))
        receipt = validate_receipt_for_request(receipt_value, request, contract_key_id, contract_secret)
        if attempt["status"] == "imported":
            return {"actionId": action["action_id"], "status": receipt["status"], "receiptId": receipt["receiptId"], "imported": attempt.get("importedDisposition", "ACKNOWLEDGE")}
        return persist_and_import_receipt(project, config, requests, receipts, attempt_path, attempt, request, receipt, state_path, state, today, contract_key_id, contract_secret)
    if attempt["status"] != "reserved":
        raise PublisherError("publisher receipt is missing for a non-reserved attempt")
    api_key = read_secret(config, "MOLTBOOK_API_KEY", str(config.get("api_key_environment_variable", "MOLTBOOK_API_KEY")), "credential_service", "credential_account")
    try:
        comment_id = exact_readback(action["target"]["post_id"], action["content"]["comment"], request["publisherAccount"], api_key, int(config.get("request_timeout_seconds", 30)), int(config.get("max_comment_pages", DEFAULT_MAX_COMMENT_PAGES)))
    except PublisherError:
        # Keep the reserved record unresolved. In particular, do not turn an
        # unavailable readback into permission to issue a second POST.
        raise
    if comment_id:
        permalink = f"{OFFICIAL_ORIGIN}/post/{urllib.parse.quote(action['target']['post_id'], safe='')}#comment-{urllib.parse.quote(comment_id, safe='')}"
        receipt = make_receipt(request, "PUBLISHED", None, None, comment_id, {"publishedAt": iso(now_utc()), "permalink": permalink}, contract_key_id, contract_secret)
    else:
        receipt = make_receipt(request, "RECONCILIATION_REQUIRED", "PRIOR_ATTEMPT_UNRESOLVED", "A prior publisher attempt has no exact readback; no POST was retried", None, None, contract_key_id, contract_secret)
    return persist_and_import_receipt(project, config, requests, receipts, attempt_path, attempt, request, receipt, state_path, state, today, contract_key_id, contract_secret)


def process(config: dict[str, Any], validate_only: bool, action_ids: set[str] | None = None) -> list[dict[str, Any]]:
    if validate_only:
        return validate_pending(config, action_ids)
    selected_ids = set(requested_action_ids(action_ids))
    project = Path(config["project_dir"]).expanduser().resolve()
    handoff = ensure_under(Path(config["handoff_dir"]), project)
    lock_path = ensure_under(Path(config.get("lock_path", handoff / "publisher.lock")), handoff)
    lock = publisher_lock(lock_path)
    try:
        return _process_locked(config, project, handoff, selected_ids)
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def _process_locked(config: dict[str, Any], project: Path, handoff: Path, action_ids: set[str]) -> list[dict[str, Any]]:
    pending = ensure_under(Path(config["pending_dir"]), project)
    requests = ensure_under(handoff / "requests", handoff)
    receipts = ensure_under(handoff / "receipts", handoff)
    attempts = ensure_under(handoff / "attempts", handoff)
    state_path = ensure_under(Path(config.get("state_path", handoff / "publisher-state.json")), handoff)
    entries, _ = collect_pending(pending, config, action_ids)
    max_actions = int(config.get("max_actions_per_cycle", 5))
    if len(entries) > max_actions:
        raise PublisherError("selected action count exceeds max_actions_per_cycle; no actions were truncated")
    daily_cap = int(config.get("daily_comment_cap", 50))
    state = load_publish_state(state_path)
    today = now_utc().date().isoformat()
    attempts_today, _, _ = _state_today(state, today)
    existing: list[tuple[dict[str, Any], dict[str, Any], Path]] = []
    new_entries: list[dict[str, Any]] = []
    for entry in entries:
        action_id = entry["transport"].get("action_id")
        try:
            validate_action(entry["transport"], config)
        except PublisherError as exc:
            raise PublisherError(f"selected action {action_id} is invalid: {exc}") from exc
        attempt_path = attempts / f"{action_id}.json"
        attempt = load_attempt(attempt_path, str(action_id), int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)))
        if attempt is None:
            new_entries.append(entry)
        else:
            existing.append((entry, attempt, attempt_path))
    if attempts_today + len(new_entries) > daily_cap:
        raise PublisherError("selected action count exceeds the remaining conservative daily attempt cap; no actions were truncated")
    contract_key_id = str(config["contract_key_id"])
    results: list[dict[str, Any]] = []
    contract_secret: str | None = None
    for entry, attempt, attempt_path in existing:
        if contract_secret is None:
            contract_secret = read_secret(config, "MOLTBOOK_PUBLISHER_CONTRACT_SECRET", str(config.get("contract_secret_environment_variable", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET")), "contract_keychain_service", "contract_keychain_account", "contract_secret_provider")
        results.append(recover_existing_attempt(project, config, entry, attempt, requests, receipts, attempt_path, state_path, state, today, contract_key_id, contract_secret))
    for entry in new_entries:
        transport = entry["transport"]
        try:
            if contract_secret is None:
                contract_secret = read_secret(config, "MOLTBOOK_PUBLISHER_CONTRACT_SECRET", str(config.get("contract_secret_environment_variable", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET")), "contract_keychain_service", "contract_keychain_account", "contract_secret_provider")
            now = now_utc()
            grant = make_grant(str(transport["action_id"]), str(config["account"]), now, contract_key_id, contract_secret)
            with tempfile.TemporaryDirectory(prefix="moltbook-grant-") as temporary:
                grant_path = Path(temporary) / "grant.json"
                atomic_write(grant_path, grant)
                prepared = run_engine(project, ["handoff", "prepare", str(transport["action_id"]), "--grant", str(grant_path), "--publisher-account", str(config["account"])], int(config.get("request_timeout_seconds", 30)), config)
            request_id = prepared.get("request", {}).get("requestId") if isinstance(prepared.get("request"), dict) else None
            if not isinstance(request_id, str) or not SAFE_ID.fullmatch(request_id):
                raise PublisherError("engine did not return a valid requestId")
            request_path = requests / f"{request_id}.json"
            request, action = load_request(request_path, config, contract_secret, int(config.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)))
            assert_kill_cleared(project, int(config.get("request_timeout_seconds", 30)), config)
            api_key = read_secret(config, "MOLTBOOK_API_KEY", str(config.get("api_key_environment_variable", "MOLTBOOK_API_KEY")), "credential_service", "credential_account")
            strict_claimed_identity(api_key, str(config["account"]), int(config.get("request_timeout_seconds", 30)))
            cooldown = int(config.get("comment_cooldown_seconds", 20))
            wait_for_cooldown(state, today, cooldown)
            attempt_path = attempts / f"{action['action_id']}.json"
            attempt = reserve_attempt(attempt_path, state_path, state, action["action_id"], request, today)
            receipt = publish_one(
                action,
                request,
                api_key,
                int(config.get("request_timeout_seconds", 30)),
                contract_key_id,
                contract_secret,
                before_post=lambda: assert_kill_cleared(project, int(config.get("request_timeout_seconds", 30)), config),
                max_pages=int(config.get("max_comment_pages", DEFAULT_MAX_COMMENT_PAGES)),
            )
            results.append(persist_and_import_receipt(project, config, requests, receipts, attempt_path, attempt, request, receipt, state_path, state, today, contract_key_id, contract_secret))
        except (PublisherError, KeyError, TypeError, ValueError) as exc:
            results.append({"actionId": transport.get("action_id"), "status": "ERROR", "error": str(exc)})
    return results


def load_publish_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        raise PublisherError(f"publisher state unavailable: {type(exc).__name__}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("date", ""), str):
        raise PublisherError("publisher state is invalid")
    for key in ("attempts", "published"):
        if key in value and (not isinstance(value[key], int) or value[key] < 0):
            raise PublisherError("publisher state is invalid")
    attempts = int(value.get("attempts", value.get("published", 0)))
    published = int(value.get("published", 0))
    if published > attempts:
        raise PublisherError("publisher state has more publications than attempts")
    value["attempts"] = attempts
    value["published"] = published
    if value.get("lastAttemptAt") is not None:
        if not isinstance(value["lastAttemptAt"], str):
            raise PublisherError("publisher state lastAttemptAt is invalid")
        try:
            parse_time(value["lastAttemptAt"])
        except ValueError as exc:
            raise PublisherError("publisher state lastAttemptAt is invalid") from exc
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--check", action="store_true", help="verify configured claimed identity without publishing")
    parser.add_argument("--action-id", action="append", default=[])
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        if args.check:
            api_key = read_secret(config, "MOLTBOOK_API_KEY", str(config.get("api_key_environment_variable", "MOLTBOOK_API_KEY")), "credential_service", "credential_account")
            strict_claimed_identity(api_key, str(config["account"]), int(config.get("request_timeout_seconds", 30)))
            print(json.dumps({"status": "READY", "account": config["account"]}, separators=(",", ":")))
            return 0
        results = process(config, args.validate_only, set(args.action_id) if args.action_id else None)
        failed = any(result.get("status") not in {"PUBLISHED", "VALID"} for result in results)
        print(json.dumps({"status": "ERROR" if failed else "OK", "results": results}, ensure_ascii=False, separators=(",", ":")))
        return 1 if failed else 0
    except PublisherError as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
