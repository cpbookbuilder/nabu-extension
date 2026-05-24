"""Test scaffolding.

Env vars must be set BEFORE the backend modules are imported, because db.py
reads DATABASE_URL at import-time and main.py validates required env vars at
import-time. httpx.AsyncClient + ASGITransport does NOT trigger FastAPI's
lifespan, so we create tables manually in the `_reset_db` autouse fixture
(this also bypasses Postgres-only DDL in `create_tables`).
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import types

# 1) Set required env vars before any backend import.
_db_path = pathlib.Path(tempfile.gettempdir()) / "nabu_test.db"
if _db_path.exists():
    _db_path.unlink()
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_db_path}")
os.environ.setdefault("JWT_SECRET", "test-secret-do-not-use-in-prod")
os.environ.setdefault("OPENAI_API_KEY", "test-api-key")
# Dummy Stripe key so restore/delete flows can exercise the Stripe-aware
# branches under monkeypatched `stripe.*` modules. Tests that need to assert
# the "no Stripe configured" branch monkeypatch STRIPE_SECRET_KEY back to "".
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_dummy")
os.environ.setdefault("BACKEND_URL", "http://test")

# 2) Make backend/ importable when pytest is invoked from repo root.
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from datetime import timezone

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

import db_models  # noqa: F401, E402 — registers models with Base
from db import AsyncSessionLocal, Base, engine  # noqa: E402
from main import app  # noqa: E402

UTC = timezone.utc  # datetime.UTC is 3.11+; we floor at 3.10 for portability.


@pytest_asyncio.fixture(autouse=True)
async def _reset_db():
    """Wipe + recreate tables for every test. Cheap on SQLite."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """The in-memory `_rate_buckets` dict in extension_routes is process-global,
    so without a reset the test client's "IP" exhausts the per-IP register
    quota a few tests into the run. Clear before every test."""
    import extension_routes as er
    er._rate_buckets.clear()
    yield


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


# ── OpenAI mocking ────────────────────────────────────────────────────────


class FakeOpenAIStream:
    """Stand-in for the async-context-manager-yielding async-iterable
    returned by `openai_client.chat.completions.stream(**kwargs)`.

    Configurable to simulate happy-path streams, fail-before-token, and
    fail-mid-stream so we can lock in the refund behaviour.
    """

    def __init__(
        self,
        deltas: tuple[str, ...] = ("Hello",),
        raise_at_enter: bool = False,
        raise_after: int | None = None,
    ):
        self.deltas = list(deltas)
        self.raise_at_enter = raise_at_enter
        self.raise_after = raise_after

    async def __aenter__(self):
        if self.raise_at_enter:
            raise RuntimeError("openai unavailable")
        return self

    async def __aexit__(self, *a):
        return False

    async def __aiter__(self):
        for i, d in enumerate(self.deltas):
            if self.raise_after is not None and i >= self.raise_after:
                raise RuntimeError("openai mid-stream failure")
            yield types.SimpleNamespace(type="content.delta", delta=d)


@pytest.fixture
def fake_openai(monkeypatch):
    """Returns a setter so tests can switch behaviour per-test:

        fake_openai(deltas=("Hi",))                  # happy path (default)
        fake_openai(raise_at_enter=True)             # 0 tokens, error
        fake_openai(deltas=("a", "b"), raise_after=1)  # 1 token then crash
    """
    import extension_routes as er

    state = {"stream": FakeOpenAIStream()}

    def fake_stream_factory(**kw):
        return state["stream"]

    monkeypatch.setattr(er.openai_client.chat.completions, "stream", fake_stream_factory)

    def setter(**kwargs):
        state["stream"] = FakeOpenAIStream(**kwargs)

    return setter


# ── Convenience: register + get JWT ───────────────────────────────────────


VALID_DEVICE_ID = "11111111-2222-3333-4444-555555555555"


async def _register(client: AsyncClient, device_id: str = VALID_DEVICE_ID) -> str:
    res = await client.post("/api/extension/register", json={"device_id": device_id})
    assert res.status_code == 200, res.text
    return res.json()["token"]


@pytest_asyncio.fixture
async def auth(client: AsyncClient) -> dict:
    """Registers VALID_DEVICE_ID and returns a {device_id, token, headers} dict."""
    token = await _register(client)
    return {
        "device_id": VALID_DEVICE_ID,
        "token": token,
        "headers": {"Authorization": f"Bearer {token}"},
    }


async def set_subscribed(device_id: str, value: bool):
    """Direct DB mutation used by tests that need a Pro user without going
    through the Stripe flow.
    """
    from sqlalchemy import update

    from db_models import ExtensionUser
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(ExtensionUser).where(ExtensionUser.id == device_id).values(subscribed=value)
        )
        await s.commit()


async def set_usage_count(device_id: str, count: int):
    """Set today's usage row directly so tests can simulate at-cap state."""
    from datetime import datetime

    from db_models import DailyUsage
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    async with AsyncSessionLocal() as s:
        # Upsert
        from sqlalchemy import select, update
        existing = (await s.execute(
            select(DailyUsage).where(DailyUsage.user_id == device_id, DailyUsage.date == today)
        )).scalar_one_or_none()
        if existing:
            await s.execute(
                update(DailyUsage)
                .where(DailyUsage.user_id == device_id, DailyUsage.date == today)
                .values(count=count)
            )
        else:
            s.add(DailyUsage(user_id=device_id, date=today, count=count))
        await s.commit()


async def get_usage_count(device_id: str) -> int:
    """Read today's usage row directly so tests can assert counter state."""
    from datetime import datetime

    from sqlalchemy import select

    from db_models import DailyUsage
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    async with AsyncSessionLocal() as s:
        row = (await s.execute(
            select(DailyUsage).where(DailyUsage.user_id == device_id, DailyUsage.date == today)
        )).scalar_one_or_none()
        return row.count if row else 0
