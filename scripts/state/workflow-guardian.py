#!/usr/bin/env python3
"""Wake Hermes when an OMXTerm PR workflow misses its expected event."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

STATE_HOME = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
STATE_DIR = Path(os.environ.get("OMXTERM_AGENT_STATE_DIR", STATE_HOME / "omxterm-agent/pr"))
SUBSCRIPTIONS = Path.home() / ".hermes/webhook_subscriptions.json"
WORKFLOW = Path(__file__).resolve().with_name("workflow.mjs")
ROUTE = "omxterm-pr-review"
URL = f"http://localhost:8644/webhooks/{ROUTE}"
ACTIVE_STATUSES = {"queued", "reviewing", "fixing"}
COOLDOWN = timedelta(minutes=10)


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def route_secret() -> str:
    subscriptions = json.loads(SUBSCRIPTIONS.read_text())
    entries = subscriptions.get("subscriptions", subscriptions)
    secret = entries[ROUTE]["secret"]
    if not secret:
        raise RuntimeError(f"Webhook route {ROUTE} has no secret")
    return secret


def continuation_pending(state: dict[str, Any]) -> bool:
    status = state.get("coordination", {}).get("status")
    continuation = (state.get("queue") or {}).get("continuation") or {}
    return status == "completed" and continuation.get("status") in ("pending", "claimed")


def due(state: dict[str, Any], now: datetime) -> bool:
    status = state.get("coordination", {}).get("status")
    # A completed PR is otherwise inactive, but a declared nextIssue leaves a durable
    # continuation record that a crashed or missed session must still be recoverable through
    # (#110); "done" is the only continuation state that stays a true no-op here.
    if status not in ACTIVE_STATUSES and not continuation_pending(state):
        return False
    deadline = parse_time(state.get("wakeup", {}).get("deadlineAt"))
    last = parse_time(state.get("wakeup", {}).get("lastTriggeredAt"))
    return bool(deadline and deadline <= now and (not last or now - last >= COOLDOWN))


def record_wakeup(pr_number: int) -> None:
    subprocess.run(
        ["node", str(WORKFLOW), "wake", "--pr", str(pr_number), "--reason", "guardian deadline reached"],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def post_wakeup(state: dict[str, Any], secret: str) -> None:
    payload = {
        "event": "workflow_wakeup",
        "action": "deadline",
        "repository": {"full_name": state["task"]["repository"]},
        "pr_number": state["task"]["pullRequest"],
        "head_sha": state["coordination"]["headSha"],
        "workflow_status": state["coordination"]["status"],
        "runner": state.get("runner"),
    }
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": "workflow_wakeup",
            "X-GitHub-Delivery": str(uuid.uuid4()),
            "X-Hub-Signature-256": f"sha256={signature}",
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"Wakeup returned HTTP {response.status}")


def main() -> None:
    now = datetime.now(timezone.utc)
    states = []
    for path in STATE_DIR.glob("*.json"):
        state = json.loads(path.read_text())
        if due(state, now):
            states.append(state)
    if not states:
        return

    secret = route_secret()
    for state in states:
        record_wakeup(state["task"]["pullRequest"])
        post_wakeup(state, secret)


if __name__ == "__main__":
    main()
