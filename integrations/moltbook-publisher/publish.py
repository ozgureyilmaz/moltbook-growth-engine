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
from typing import Any


OFFICIAL_ORIGIN = "https://www.moltbook.com"
API_BASE = f"{OFFICIAL_ORIGIN}/api/v1"
DEFAULT_CONFIG = Path.home() / ".hermes" / "data" / "moltbook-publisher.json"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


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
    required = {"account", "project_dir", "pending_dir", "handoff_dir", "credential_service", "credential_account", "contract_keychain_service", "contract_keychain_account", "contract_key_id"}
    missing = sorted(required - value.keys())
    if missing:
        raise PublisherError(f"publisher config missing: {','.join(missing)}")
    for key in required:
        if not isinstance(value[key], str) or not value[key].strip():
            raise PublisherError(f"publisher config field is invalid: {key}")
    for key in ("max_actions_per_cycle", "daily_comment_cap", "request_timeout_seconds"):
        if key in value and (not isinstance(value[key], int) or value[key] < 1):
            raise PublisherError(f"publisher config field is invalid: {key}")
    cooldown = value.get("comment_cooldown_seconds", 20)
    if not isinstance(cooldown, int) or cooldown < 20:
        raise PublisherError("comment_cooldown_seconds must be at least 20")
    if int(value.get("max_actions_per_cycle", 5)) > int(value.get("daily_comment_cap", 50)):
        raise PublisherError("max_actions_per_cycle exceeds daily_comment_cap")
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


def read_secret(config: dict[str, Any], key: str, environment_key: str, service_key: str, account_key: str) -> str:
    if config.get("secret_provider") == "environment":
        value = os.environ.get(environment_key, "").strip()
        if not value:
            raise PublisherError(f"publisher environment secret unavailable: {environment_key}")
        return value
    return read_keychain(str(config[service_key]), str(config[account_key]))


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


def run_engine(project: Path, args: list[str], timeout: int) -> dict[str, Any]:
    node = os.environ.get("MARX_GROWTH_NODE", "node")
    cli = project / "dist" / "cli" / "main.js"
    if not cli.is_file():
        raise PublisherError("engine build is missing dist/cli/main.js")
    env = {key: os.environ[key] for key in ("PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "MARX_GROWTH_CONFIG_DIR", "MARX_GROWTH_DB", "MARX_TRACKER_API_TOKEN", "MOLTBOOK_API_KEY", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET") if key in os.environ}
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


def http_json(url: str, method: str, api_key: str, body: dict[str, Any] | None, timeout: int) -> dict[str, Any]:
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
            raw = response.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, PublisherError) as exc:
        raise PublisherError(f"Moltbook provider request failed: {type(exc).__name__}") from exc
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublisherError("Moltbook provider returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise PublisherError("Moltbook provider returned a non-object")
    return value


def flatten_comments(comments: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in comments:
        if not isinstance(item, dict):
            continue
        result.append(item)
        nested = item.get("replies")
        if isinstance(nested, list):
            result.extend(flatten_comments(nested))
    return result


def exact_readback(post_id: str, comment_text: str, publisher_account: str, api_key: str, timeout: int) -> str | None:
    readback = http_json(f"{API_BASE}/posts/{urllib.parse.quote(post_id, safe='')}/comments?sort=new&limit=100", "GET", api_key, None, timeout)
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
    return None


def readback_after_publish(post_id: str, comment_text: str, publisher_account: str, api_key: str, timeout: int) -> str | None:
    # Moltbook can accept a comment before it becomes visible to the comments GET.
    # Poll briefly, then require reconciliation rather than risking a duplicate POST.
    # Moltbook's comment GET can lag the successful POST by several seconds.
    # Poll for a slightly longer, still bounded window before requiring
    # reconciliation; never issue a second POST for the same action.
    for attempt in range(6):
        comment_id = exact_readback(post_id, comment_text, publisher_account, api_key, timeout)
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


def publish_one(action: dict[str, Any], request: dict[str, Any], api_key: str, timeout: int, key_id: str, contract_secret: str) -> dict[str, Any]:
    post_id = action["target"]["post_id"]
    comment_text = action["content"]["comment"]
    publisher_account = request["publisherAccount"]
    try:
        existing_comment_id = exact_readback(post_id, comment_text, publisher_account, api_key, timeout)
    except PublisherError as exc:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PREWRITE_READBACK_FAILED", str(exc), None, None, key_id, contract_secret)
    if existing_comment_id:
        published_at = iso(now_utc())
        permalink = f"{OFFICIAL_ORIGIN}/post/{urllib.parse.quote(post_id, safe='')}#comment-{urllib.parse.quote(existing_comment_id, safe='')}"
        return make_receipt(request, "PUBLISHED", None, None, existing_comment_id, {"publishedAt": published_at, "permalink": permalink}, key_id, contract_secret)
    try:
        response = http_json(f"{API_BASE}/posts/{urllib.parse.quote(post_id, safe='')}/comments", "POST", api_key, {"content": comment_text}, timeout)
    except PublisherError as exc:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_REQUEST_FAILED", str(exc), None, None, key_id, contract_secret)
    if response.get("success") is not True:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_REJECTED", "provider did not report success", None, None, key_id, contract_secret)
    if response.get("verification_required") is True or isinstance(response.get("verification"), dict):
        return make_receipt(request, "VERIFICATION_REQUIRED", "PLATFORM_VERIFICATION_REQUIRED", "provider requested verification", None, None, key_id, contract_secret)
    comment = response.get("comment")
    comment_id = comment.get("id") if isinstance(comment, dict) else None
    if not isinstance(comment_id, str) or not comment_id:
        return make_receipt(request, "RECONCILIATION_REQUIRED", "PROVIDER_COMMENT_ID_MISSING", "provider success did not include a comment id", None, None, key_id, contract_secret)
    try:
        readback_comment_id = readback_after_publish(post_id, comment_text, publisher_account, api_key, timeout)
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
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


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


def process(config: dict[str, Any], validate_only: bool, action_ids: set[str] | None = None) -> list[dict[str, Any]]:
    project = Path(config["project_dir"]).expanduser().resolve()
    handoff = ensure_under(Path(config["handoff_dir"]), project)
    lock_path = ensure_under(Path(config.get("lock_path", handoff / "publisher.lock")), handoff)
    lock = publisher_lock(lock_path)
    try:
        return _process_locked(config, validate_only, project, handoff, action_ids)
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def _process_locked(config: dict[str, Any], validate_only: bool, project: Path, handoff: Path, action_ids: set[str] | None = None) -> list[dict[str, Any]]:
    pending = ensure_under(Path(config["pending_dir"]), project)
    requests = ensure_under(handoff / "requests", handoff)
    receipts = ensure_under(handoff / "receipts", handoff)
    pending.mkdir(parents=True, exist_ok=True)
    max_actions = int(config.get("max_actions_per_cycle", 5))
    daily_cap = int(config.get("daily_comment_cap", 50))
    state_path = ensure_under(Path(config.get("state_path", handoff / "publisher-state.json")), handoff)
    state = load_publish_state(state_path)
    today = now_utc().date().isoformat()
    published_today = int(state.get("date") == today and state.get("published", 0) or 0)
    if published_today >= daily_cap:
        return [{"status": "DAILY_CAP_REACHED", "publishedToday": published_today}]
    contract_key_id = str(config["contract_key_id"])
    entries: list[dict[str, Any]] = []
    for path in sorted(pending.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("action") == "COMMENT" and (action_ids is None or raw.get("action_id") in action_ids):
                entries.append({"path": path, "transport": raw})
        except (OSError, json.JSONDecodeError) as exc:
            quarantine_pending(path, f"pending action could not be decoded: {type(exc).__name__}")
            continue
    results: list[dict[str, Any]] = []
    last_publish_attempt = 0.0
    for entry in entries[:min(max_actions, daily_cap - published_today)]:
        transport = entry["transport"]
        try:
            validate_action(transport, config)
        except PublisherError as exc:
            quarantine_pending(entry["path"], str(exc))
            results.append({"actionId": transport.get("action_id"), "status": "QUARANTINED", "error": str(exc)})
            continue
        try:
            if validate_only:
                results.append({"actionId": transport.get("action_id"), "status": "VALID"})
                continue
            now = now_utc()
            contract_secret = read_secret(config, "MOLTBOOK_PUBLISHER_CONTRACT_SECRET", str(config.get("contract_secret_environment_variable", "MOLTBOOK_PUBLISHER_CONTRACT_SECRET")), "contract_keychain_service", "contract_keychain_account")
            grant = make_grant(str(transport["action_id"]), str(config["account"]), now, contract_key_id, contract_secret)
            with tempfile.TemporaryDirectory(prefix="moltbook-grant-") as temporary:
                grant_path = Path(temporary) / "grant.json"
                atomic_write(grant_path, grant)
                prepared = run_engine(project, ["handoff", "prepare", str(transport["action_id"]), "--grant", str(grant_path), "--publisher-account", str(config["account"])], int(config.get("request_timeout_seconds", 30)))
            request_id = prepared.get("request", {}).get("requestId")
            if not isinstance(request_id, str) or not SAFE_ID.fullmatch(request_id):
                raise PublisherError("engine did not return a valid requestId")
            request_path = requests / f"{request_id}.json"
            request = json.loads(request_path.read_text(encoding="utf-8"))
            if not isinstance(request, dict):
                raise PublisherError("prepared request is invalid")
            action = verify_request(request, config, now_utc(), contract_secret)
            kill_status = run_engine(project, ["ops", "kill-status"], int(config.get("request_timeout_seconds", 30)))
            if kill_status.get("status") != "CLEARED":
                raise PublisherError("publisher-side kill switch is engaged")
            api_key = read_secret(config, "MOLTBOOK_API_KEY", str(config.get("api_key_environment_variable", "MOLTBOOK_API_KEY")), "credential_service", "credential_account")
            identity = http_json(f"{API_BASE}/agents/status", "GET", api_key, None, int(config.get("request_timeout_seconds", 30)))
            if identity.get("status") != "claimed":
                raise PublisherError("Moltbook publisher agent is not claimed")
            agent = identity.get("agent")
            if isinstance(agent, dict) and agent.get("name") not in (None, config["account"]):
                raise PublisherError("Moltbook publisher account does not match claimed agent")
            elapsed = time.monotonic() - last_publish_attempt
            cooldown = int(config.get("comment_cooldown_seconds", 20))
            if last_publish_attempt > 0 and elapsed < cooldown:
                time.sleep(cooldown - elapsed)
            last_publish_attempt = time.monotonic()
            receipt = publish_one(action, request, api_key, int(config.get("request_timeout_seconds", 30)), contract_key_id, contract_secret)
            receipt_path = receipts / f"{request_id}.json"
            atomic_write(receipt_path, receipt)
            imported = run_engine(project, ["handoff", "import-receipt", request_id, "--receipt", str(receipt_path)], int(config.get("request_timeout_seconds", 30)))
            if receipt["status"] == "PUBLISHED":
                published_today += 1
                atomic_write(state_path, {"date": today, "published": published_today})
            results.append({"actionId": action["action_id"], "status": receipt["status"], "receiptId": receipt["receiptId"], "imported": imported.get("disposition")})
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
    if not isinstance(value, dict) or not isinstance(value.get("date", ""), str) or not isinstance(value.get("published", 0), int) or value.get("published", 0) < 0:
        raise PublisherError("publisher state is invalid")
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
            identity = http_json(f"{API_BASE}/agents/me", "GET", api_key, None, int(config.get("request_timeout_seconds", 30)))
            agent = identity.get("agent") if isinstance(identity.get("agent"), dict) else identity
            if not isinstance(agent, dict) or agent.get("name") != config["account"] or agent.get("is_claimed") is not True:
                raise PublisherError("Moltbook /agents/me identity is not claimed or does not match configured account")
            print(json.dumps({"status": "READY", "account": config["account"]}, separators=(",", ":")))
            return 0
        if not args.validate_only and not args.action_id:
            raise PublisherError("real publisher runs require one or more explicit --action-id values")
        results = process(config, args.validate_only, set(args.action_id) if args.action_id else None)
        if results:
            print(json.dumps({"status": "OK", "results": results}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except PublisherError as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
