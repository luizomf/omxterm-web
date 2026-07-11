#!/usr/bin/env python3
"""Filter GitHub events and persist review wakeups before Hermes starts."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

EXPECTED_REPOSITORY = "luizomf/omxterm"
MAINTAINER_LOGIN = "luizomf"
PULL_REQUEST_ACTIONS = {"opened", "ready_for_review", "reopened", "synchronize"}
COMMENT_ACTIONS = {"created", "edited"}
COMMENT_TRIGGER = re.compile(r"(?:^|\s)(?:@brien|/brien|/review)(?=\s|$)", re.IGNORECASE)
AGENT_RESPONSE_MARKER = "<!-- brien-webhook-response -->"
MAX_COMMENT_LENGTH = 2_000
WORKFLOW = Path(os.environ.get("OMXTERM_WORKFLOW_CLI", Path(__file__).resolve().with_name("workflow.mjs")))
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def ignore() -> None:
    print("[SILENT]")


def text(value: Any, limit: int = MAX_COMMENT_LENGTH) -> str:
    return str(value or "")[:limit]


def deadline() -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat().replace("+00:00", "Z")


def persist_pull_request_event(pr_number: int, head_sha: str, action: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            "node", str(WORKFLOW), "ingest", "--pr", str(pr_number),
            "--sha", head_sha, "--action", action, "--deadline-at", deadline(),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "workflow ingest failed")
    state = json.loads(result.stdout)
    return state.get("command", {"outcome": "event_queued"})


def normalize_pull_request(payload: dict[str, Any]) -> dict[str, Any] | None:
    action = payload.get("action")
    pull_request = payload.get("pull_request")
    if action not in PULL_REQUEST_ACTIONS or not isinstance(pull_request, dict):
        return None
    if pull_request.get("draft") and action != "ready_for_review":
        return None

    pr_number = pull_request.get("number") or payload.get("number")
    head_sha = text((pull_request.get("head") or {}).get("sha"), 200)
    if not pr_number or not head_sha:
        return None
    state_ingest = persist_pull_request_event(pr_number, head_sha, action)
    return {
        "event": "pull_request",
        "action": action,
        "repository": EXPECTED_REPOSITORY,
        "workdir": str(REPOSITORY_ROOT),
        "pr_number": pr_number,
        "title": text(pull_request.get("title"), 500),
        "url": text(pull_request.get("html_url"), 1_000),
        "sender": text((payload.get("sender") or {}).get("login"), 200),
        "author": text((pull_request.get("user") or {}).get("login"), 200),
        "head_sha": head_sha,
        "base_ref": text((pull_request.get("base") or {}).get("ref"), 200),
        "state_ingest": state_ingest,
        "trigger": "Reconcile and review the current pull request state.",
    }


def normalize_wakeup(payload: dict[str, Any]) -> dict[str, Any] | None:
    if payload.get("event") != "workflow_wakeup" or payload.get("action") != "deadline":
        return None
    if not payload.get("pr_number") or not payload.get("head_sha"):
        return None
    return {
        "event": "workflow_wakeup",
        "action": "deadline",
        "repository": EXPECTED_REPOSITORY,
        "workdir": str(REPOSITORY_ROOT),
        "pr_number": payload["pr_number"],
        "head_sha": text(payload["head_sha"], 200),
        "workflow_status": text(payload.get("workflow_status"), 100),
        "runner": payload.get("runner"),
        "trigger": "Reconcile an overdue workflow without assuming the expected event arrived.",
    }


def normalize_comment(payload: dict[str, Any]) -> dict[str, Any] | None:
    action = payload.get("action")
    comment = payload.get("comment")
    sender = payload.get("sender") or {}
    if action not in COMMENT_ACTIONS or not isinstance(comment, dict):
        return None
    if sender.get("login") != MAINTAINER_LOGIN:
        return None

    body = text(comment.get("body"))
    if AGENT_RESPONSE_MARKER in body or not COMMENT_TRIGGER.search(body):
        return None

    pull_request = payload.get("pull_request")
    issue = payload.get("issue")
    if isinstance(pull_request, dict):
        event = "pull_request_review_comment"
        pr_number = pull_request.get("number") or payload.get("number")
    elif isinstance(issue, dict) and issue.get("pull_request"):
        event = "issue_comment"
        pr_number = issue.get("number")
        pull_request = issue
    else:
        return None

    normalized = {
        "event": event,
        "action": action,
        "repository": EXPECTED_REPOSITORY,
        "workdir": str(REPOSITORY_ROOT),
        "pr_number": pr_number,
        "title": text((pull_request or {}).get("title"), 500),
        "url": text((pull_request or {}).get("html_url"), 1_000),
        "sender": MAINTAINER_LOGIN,
        "comment_id": comment.get("id"),
        "comment": body,
        "trigger": "Handle the maintainer request after reconciling active workflow ownership.",
    }
    if event == "pull_request_review_comment":
        normalized.update({
            "path": text(comment.get("path"), 1_000),
            "line": comment.get("line") or comment.get("original_line"),
            "side": text(comment.get("side"), 50),
            "commit_id": text(comment.get("commit_id"), 200),
            "in_reply_to_id": comment.get("in_reply_to_id"),
        })
    return normalized


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        ignore()
        return 0
    if not isinstance(payload, dict):
        ignore()
        return 0
    repository = payload.get("repository") or {}
    if repository.get("full_name") != EXPECTED_REPOSITORY:
        ignore()
        return 0

    try:
        if payload.get("event") == "workflow_wakeup":
            normalized = normalize_wakeup(payload)
        elif "comment" in payload:
            normalized = normalize_comment(payload)
        else:
            normalized = normalize_pull_request(payload)
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"state-ingest: {error}", file=sys.stderr)
        return 1

    if normalized is None or not normalized.get("pr_number"):
        ignore()
        return 0
    print(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
