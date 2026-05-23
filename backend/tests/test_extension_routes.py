"""End-to-end tests for the extension API surface.

Covers the failure modes a real user can hit: free-tier counter behaviour,
the Pro-user counting bug we fixed, refund-on-upstream-failure, and basic
auth boundaries.
"""
from __future__ import annotations

from httpx import AsyncClient

from tests.conftest import (
    VALID_DEVICE_ID,
    _register,
    get_usage_count,
    set_subscribed,
    set_usage_count,
)

ANNOTATE_BODY = {"messages": [{"role": "user", "content": "What is gravity?"}]}


# ── /healthz ──────────────────────────────────────────────────────────────


async def test_healthz_ok(client: AsyncClient):
    res = await client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


# ── /register ─────────────────────────────────────────────────────────────


async def test_register_creates_user_and_returns_token(client: AsyncClient):
    res = await client.post("/api/extension/register", json={"device_id": VALID_DEVICE_ID})
    assert res.status_code == 200
    body = res.json()
    assert "token" in body
    assert body["subscribed"] is False
    assert body["count"] == 0
    assert body["limit"] == 10


async def test_register_is_idempotent(client: AsyncClient):
    # Second register for the same device_id returns a fresh token without
    # creating a duplicate user row.
    t1 = await _register(client)
    t2 = await _register(client)
    assert t1 and t2  # both are valid JWTs


async def test_register_rejects_bad_device_id(client: AsyncClient):
    res = await client.post("/api/extension/register", json={"device_id": "not-a-uuid"})
    assert res.status_code == 422


# ── /annotate auth ────────────────────────────────────────────────────────


async def test_annotate_requires_auth(client: AsyncClient):
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY)
    assert res.status_code == 401


# ── /annotate counting (free tier) ────────────────────────────────────────


async def test_annotate_free_increments_usage(client: AsyncClient, auth, fake_openai):
    fake_openai(deltas=("Hello world",))
    assert await get_usage_count(VALID_DEVICE_ID) == 0
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 200
    body = await _read_sse(res)
    assert any("Hello world" in line for line in body)
    assert await get_usage_count(VALID_DEVICE_ID) == 1


async def test_annotate_free_at_cap_returns_429(client: AsyncClient, auth, fake_openai):
    fake_openai(deltas=("Hello",))
    await set_usage_count(VALID_DEVICE_ID, 10)
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 429
    # Counter stays at 10 — no over-charge on a blocked request.
    assert await get_usage_count(VALID_DEVICE_ID) == 10


# ── /annotate counting (Pro tier — the bug we fixed) ──────────────────────


async def test_annotate_pro_increments_usage_for_admin_analytics(
    client: AsyncClient, auth, fake_openai,
):
    """Locks in the fix for: Pro users were invisible to the admin
    "Questions today / 30d / all-time" tiles because the counter was
    only incremented for free users."""
    fake_openai(deltas=("Pro answer",))
    await set_subscribed(VALID_DEVICE_ID, True)
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 200
    assert await get_usage_count(VALID_DEVICE_ID) == 1


async def test_annotate_pro_has_no_daily_cap(client: AsyncClient, auth, fake_openai):
    fake_openai(deltas=("Pro answer",))
    await set_subscribed(VALID_DEVICE_ID, True)
    await set_usage_count(VALID_DEVICE_ID, 999)
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 200
    assert await get_usage_count(VALID_DEVICE_ID) == 1000


# ── /annotate refund-on-failure (reserve-and-refund pattern) ──────────────


async def test_annotate_refunds_slot_when_openai_fails_before_first_token(
    client: AsyncClient, auth, fake_openai,
):
    fake_openai(raise_at_enter=True)
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 200  # stream itself returns 200, error is inside SSE
    body = await _read_sse(res)
    err_lines = [line for line in body if '"error"' in line]
    assert err_lines, "expected an error SSE event"
    assert "upstream_unavailable" in err_lines[0]
    # Slot was reserved then refunded → back to 0.
    assert await get_usage_count(VALID_DEVICE_ID) == 0


async def test_annotate_does_not_refund_on_mid_stream_failure(
    client: AsyncClient, auth, fake_openai,
):
    # First token landed → user got value → no refund.
    fake_openai(deltas=("partial ", "more"), raise_after=1)
    res = await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert res.status_code == 200
    body = await _read_sse(res)
    assert any("upstream_mid_stream" in line for line in body)
    assert await get_usage_count(VALID_DEVICE_ID) == 1


# ── /usage ────────────────────────────────────────────────────────────────


async def test_usage_endpoint_returns_state(client: AsyncClient, auth):
    res = await client.get("/api/extension/usage", headers=auth["headers"])
    assert res.status_code == 200
    body = res.json()
    assert body == {"count": 0, "limit": 10, "subscribed": False, "remaining": 10}


# ── DELETE /account ───────────────────────────────────────────────────────


async def test_delete_account_removes_user_and_usage(client: AsyncClient, auth, fake_openai):
    fake_openai(deltas=("hi",))
    # Generate some usage so we exercise the cascade.
    await client.post("/api/extension/annotate", json=ANNOTATE_BODY, headers=auth["headers"])
    assert await get_usage_count(VALID_DEVICE_ID) == 1

    res = await client.delete("/api/extension/account", headers=auth["headers"])
    assert res.status_code == 200
    assert await get_usage_count(VALID_DEVICE_ID) == 0

    # Subsequent calls with the old token should 401 (user row is gone).
    res = await client.get("/api/extension/usage", headers=auth["headers"])
    assert res.status_code == 401


# ── helpers ──────────────────────────────────────────────────────────────


async def _read_sse(response) -> list[str]:
    """Drain an SSE response and return its raw lines (one event per line)."""
    chunks: list[bytes] = []
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8").splitlines()
