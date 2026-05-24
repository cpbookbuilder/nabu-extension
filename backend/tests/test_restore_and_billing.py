"""Tests for the new two-step restore flow and the broader Stripe
cancellation predicate in DELETE /account.

The new restore (post-2026-05-23) fixes the takeover bug where any caller
who knew a Pro subscriber's email could transfer Pro to their own device.
Restore now hands back a Stripe Customer Portal URL whose return_url is a
signed ticket; only Stripe's email-link auth can redeem the ticket.

All Stripe interactions here are monkeypatched — we never hit the real API.
"""
from __future__ import annotations

import types
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from tests.conftest import VALID_DEVICE_ID, _register

UTC = timezone.utc


# ── Fake Stripe primitives ────────────────────────────────────────────────


def _customer(id: str = "cus_test", email: str = "user@example.com"):
    return types.SimpleNamespace(id=id, email=email)


def _subscription(status: str, id: str = "sub_test"):
    return types.SimpleNamespace(id=id, status=status)


class _ListWrap:
    """Mimics Stripe's list response wrapper (.data + auto_paging_iter)."""
    def __init__(self, items):
        self.data = list(items)

    def auto_paging_iter(self):
        return iter(self.data)


@pytest.fixture
def fake_stripe(monkeypatch):
    """Monkeypatches the parts of `stripe.*` that /restore + DELETE /account
    touch. Returns a dict so each test can rewire individual calls.
    """
    import extension_routes as er

    state = {
        "customers": [],                # returned by Customer.list(email=...)
        "subs_by_customer": {},          # customer_id → list of statuses
        "portal_url": "https://billing.stripe.test/session/redirect",
        "deleted_subs": [],              # appended by Subscription.delete
    }

    def customer_list(**kw):
        return _ListWrap(state["customers"])

    def customer_retrieve(cust_id):
        for c in state["customers"]:
            if c.id == cust_id:
                return c
        return _customer(id=cust_id, email="")

    def subscription_list(customer, **kw):
        statuses = state["subs_by_customer"].get(customer, [])
        return _ListWrap([_subscription(s, id=f"sub_{i}") for i, s in enumerate(statuses)])

    def subscription_delete(sub_id):
        state["deleted_subs"].append(sub_id)

    def portal_create(customer, return_url):
        # Echo back the return_url so the test can decode the ticket from it.
        state["last_return_url"] = return_url
        return types.SimpleNamespace(url=f"{state['portal_url']}?return={return_url}")

    monkeypatch.setattr(er.stripe.Customer, "list", customer_list)
    monkeypatch.setattr(er.stripe.Customer, "retrieve", customer_retrieve)
    monkeypatch.setattr(er.stripe.Subscription, "list", subscription_list)
    monkeypatch.setattr(er.stripe.Subscription, "delete", subscription_delete)
    monkeypatch.setattr(er.stripe.billing_portal.Session, "create", portal_create)
    return state


# ── /restore ──────────────────────────────────────────────────────────────


async def test_restore_returns_generic_when_no_stripe_customer_matches(
    client: AsyncClient, fake_stripe,
):
    # No Stripe customers for this email → generic response, no verify_url.
    fake_stripe["customers"] = []
    res = await client.post("/api/extension/restore", json={
        "email": "stranger@example.com", "device_id": VALID_DEVICE_ID,
    })
    assert res.status_code == 200
    body = res.json()
    assert "verify_url" not in body
    assert "message" in body


async def test_restore_returns_generic_when_customer_has_no_billable_subscription(
    client: AsyncClient, fake_stripe,
):
    # Customer exists but only has terminal subscriptions — no portal URL.
    fake_stripe["customers"] = [_customer(id="cus_x")]
    fake_stripe["subs_by_customer"] = {"cus_x": ["canceled", "incomplete_expired"]}
    res = await client.post("/api/extension/restore", json={
        "email": "lapsed@example.com", "device_id": VALID_DEVICE_ID,
    })
    assert res.status_code == 200
    assert "verify_url" not in res.json()


async def test_restore_returns_portal_url_when_active_subscription_exists(
    client: AsyncClient, fake_stripe,
):
    fake_stripe["customers"] = [_customer(id="cus_pro", email="pro@example.com")]
    fake_stripe["subs_by_customer"] = {"cus_pro": ["active"]}
    res = await client.post("/api/extension/restore", json={
        "email": "pro@example.com", "device_id": VALID_DEVICE_ID,
    })
    assert res.status_code == 200
    body = res.json()
    assert "verify_url" in body
    assert body["verify_url"].startswith(fake_stripe["portal_url"])
    # Ticket is embedded in the return_url we handed to Stripe.
    assert "ticket=" in fake_stripe["last_return_url"]


async def test_restore_503_when_stripe_not_configured(client: AsyncClient, monkeypatch):
    import extension_routes as er
    monkeypatch.setattr(er, "STRIPE_SECRET_KEY", "")
    res = await client.post("/api/extension/restore", json={
        "email": "anyone@example.com", "device_id": VALID_DEVICE_ID,
    })
    assert res.status_code == 503


# ── /restore-complete ─────────────────────────────────────────────────────


def _mint_ticket(device_id: str, customer_id: str, ttl_min: int = 5) -> str:
    """Forge a valid ticket exactly the way /restore mints one — lets us
    bypass the Stripe portal step in tests without exposing the helper."""
    import jwt

    import extension_routes as er
    return jwt.encode(
        {
            "type": "restore",
            "device_id": device_id,
            "customer_id": customer_id,
            "exp": datetime.now(UTC) + timedelta(minutes=ttl_min),
        },
        er.JWT_SECRET,
        algorithm=er.JWT_ALGORITHM,
    )


async def test_restore_complete_rejects_invalid_ticket(client: AsyncClient, fake_stripe):
    res = await client.get("/api/extension/restore-complete", params={"ticket": "garbage"})
    assert res.status_code == 200  # branded page, not 4xx — UX choice
    assert "expired or invalid" in res.text


async def test_restore_complete_rejects_expired_ticket(client: AsyncClient, fake_stripe):
    expired = _mint_ticket(VALID_DEVICE_ID, "cus_x", ttl_min=-1)
    res = await client.get("/api/extension/restore-complete", params={"ticket": expired})
    assert "expired or invalid" in res.text


async def test_restore_complete_transfers_pro_when_subscription_is_billable(
    client: AsyncClient, auth, fake_stripe,
):
    # Setup: target device already exists (registered via auth fixture), not Pro.
    fake_stripe["customers"] = [_customer(id="cus_pro", email="pro@example.com")]
    fake_stripe["subs_by_customer"] = {"cus_pro": ["trialing"]}  # non-active billable

    ticket = _mint_ticket(VALID_DEVICE_ID, "cus_pro")
    res = await client.get("/api/extension/restore-complete", params={"ticket": ticket})
    assert res.status_code == 200
    assert "Pro restored" in res.text

    # Device row should now show subscribed=True.
    usage_res = await client.get("/api/extension/usage", headers=auth["headers"])
    assert usage_res.json()["subscribed"] is True


async def test_restore_complete_detaches_pro_from_other_devices_with_same_customer(
    client: AsyncClient, fake_stripe,
):
    # Two devices both linked to the same Stripe customer would be a bug —
    # /restore-complete should detach any existing one before attaching the new.
    from sqlalchemy import select

    from db_models import ExtensionUser
    from tests.conftest import AsyncSessionLocal
    other_device = "99999999-aaaa-bbbb-cccc-dddddddddddd"
    new_device = VALID_DEVICE_ID

    async with AsyncSessionLocal() as s:
        s.add(ExtensionUser(
            id=other_device, email="pro@example.com",
            subscribed=True, stripe_customer_id="cus_shared",
        ))
        s.add(ExtensionUser(id=new_device, email="", subscribed=False))
        await s.commit()

    fake_stripe["customers"] = [_customer(id="cus_shared", email="pro@example.com")]
    fake_stripe["subs_by_customer"] = {"cus_shared": ["active"]}
    ticket = _mint_ticket(new_device, "cus_shared")
    res = await client.get("/api/extension/restore-complete", params={"ticket": ticket})
    assert "Pro restored" in res.text

    async with AsyncSessionLocal() as s:
        rows = (await s.execute(select(ExtensionUser).order_by(ExtensionUser.id))).scalars().all()
        by_id = {r.id: r for r in rows}
        assert by_id[new_device].subscribed is True
        assert by_id[other_device].subscribed is False
        assert by_id[other_device].stripe_customer_id is None


# ── DELETE /account: broader Stripe cancellation ──────────────────────────


async def test_delete_account_cancels_all_billable_states_not_just_active(
    client: AsyncClient, auth, fake_stripe,
):
    """Locks in the fix for: cancellation used to filter status="active",
    missing trialing/past_due/etc., which left the customer being billed.
    """
    from sqlalchemy import update

    from db_models import ExtensionUser
    from tests.conftest import AsyncSessionLocal
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(ExtensionUser)
            .where(ExtensionUser.id == VALID_DEVICE_ID)
            .values(subscribed=True, stripe_customer_id="cus_mixed")
        )
        await s.commit()

    fake_stripe["subs_by_customer"] = {
        "cus_mixed": ["active", "trialing", "past_due", "canceled"],
    }

    res = await client.delete("/api/extension/account", headers=auth["headers"])
    assert res.status_code == 200
    body = res.json()
    assert body["stripe_cancelled"] is True
    # 3 billable subs (active, trialing, past_due) deleted; canceled was skipped.
    assert len(fake_stripe["deleted_subs"]) == 3


# ── last_seen_at touch ────────────────────────────────────────────────────


async def test_register_sets_last_seen_at(client: AsyncClient):
    from sqlalchemy import select

    from db_models import ExtensionUser
    from tests.conftest import AsyncSessionLocal
    await _register(client)
    async with AsyncSessionLocal() as s:
        user = (await s.execute(
            select(ExtensionUser).where(ExtensionUser.id == VALID_DEVICE_ID)
        )).scalar_one()
    assert user.last_seen_at is not None
    # SQLite drops tz on read — compare naively. Postgres preserves tz in prod.
    seen = user.last_seen_at.replace(tzinfo=None) if user.last_seen_at.tzinfo else user.last_seen_at
    assert (datetime.utcnow() - seen).total_seconds() < 5


async def test_annotate_bumps_last_seen_at(client: AsyncClient, auth, fake_openai):
    from sqlalchemy import select, update

    from db_models import ExtensionUser
    from tests.conftest import AsyncSessionLocal
    fake_openai(deltas=("hi",))

    # Backdate to confirm the bump.
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(ExtensionUser)
            .where(ExtensionUser.id == VALID_DEVICE_ID)
            .values(last_seen_at=datetime.now(UTC) - timedelta(days=10))
        )
        await s.commit()

    await client.post(
        "/api/extension/annotate",
        json={"messages": [{"role": "user", "content": "what is gravity"}]},
        headers=auth["headers"],
    )

    async with AsyncSessionLocal() as s:
        user = (await s.execute(
            select(ExtensionUser).where(ExtensionUser.id == VALID_DEVICE_ID)
        )).scalar_one()
    # SQLite drops tz on read — compare naively. Postgres preserves tz in prod.
    seen = user.last_seen_at.replace(tzinfo=None) if user.last_seen_at.tzinfo else user.last_seen_at
    assert (datetime.utcnow() - seen).total_seconds() < 5
