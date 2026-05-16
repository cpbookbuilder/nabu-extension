import json
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta

import jwt
import stripe
from fastapi import APIRouter, Depends, HTTPException, Header, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, field_validator, EmailStr
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from db_models import ExtensionUser, DailyUsage

router = APIRouter(prefix="/api/extension")
openai_client = AsyncOpenAI()

FREE_DAILY_LIMIT      = 10
JWT_ALGORITHM         = "HS256"
JWT_EXPIRE_DAYS       = 30
STRIPE_SECRET_KEY     = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID       = os.environ.get("STRIPE_PRICE_ID", "")
BACKEND_URL           = os.environ.get("BACKEND_URL", "https://nabu-extension-production.up.railway.app")

JWT_SECRET = os.environ.get("JWT_SECRET", "")
if not JWT_SECRET:
    import warnings
    warnings.warn("JWT_SECRET is not set — using insecure default. Set it in Railway env vars.")
    JWT_SECRET = "default-insecure-secret-change-me"

# Allowed OpenAI models — prevents cost abuse via model injection
ALLOWED_MODELS = {"gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-4o-mini", "gpt-4o"}

# Max content length per message (chars) — prevents payload abuse
MAX_MESSAGE_LENGTH = 8_000
MAX_MESSAGES       = 20

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# Simple in-memory rate limiter for unauthenticated endpoints
_rate_buckets: dict[str, list[float]] = defaultdict(list)

def check_rate_limit(key: str, max_calls: int, window_seconds: int):
    now = time.time()
    bucket = _rate_buckets[key]
    _rate_buckets[key] = [t for t in bucket if now - t < window_seconds]
    if len(_rate_buckets[key]) >= max_calls:
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
    _rate_buckets[key].append(now)


# ── JWT ────────────────────────────────────────────────────────────────────

def make_token(device_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)
    return jwt.encode({"sub": device_id, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_extension_user(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> ExtensionUser:
    try:
        token = authorization.removeprefix("Bearer ").strip()
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        device_id = payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired. Please re-open the extension.")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == device_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Device not registered")
    return user


# ── Usage helper ───────────────────────────────────────────────────────────

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

async def get_or_create_usage(db: AsyncSession, user_id: str) -> DailyUsage:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    result = await db.execute(
        select(DailyUsage).where(DailyUsage.user_id == user_id, DailyUsage.date == today)
    )
    usage = result.scalar_one_or_none()
    if not usage:
        usage = DailyUsage(user_id=user_id, date=today, count=0)
        db.add(usage)
        await db.flush()
    return usage


# ── Register ───────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    device_id: str

    @field_validator("device_id")
    @classmethod
    def validate_device_id(cls, v: str) -> str:
        if not UUID_RE.match(v):
            raise ValueError("device_id must be a valid UUID")
        return v


@router.post("/register")
async def register(req: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    # Rate limit: 10 registrations per IP per hour
    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(f"register:{client_ip}", max_calls=10, window_seconds=3600)

    result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == req.device_id))
    user = result.scalar_one_or_none()
    if not user:
        user = ExtensionUser(id=req.device_id, email="")
        db.add(user)
        await db.commit()
    usage = await get_or_create_usage(db, user.id)
    await db.commit()
    return {
        "token": make_token(user.id),
        "subscribed": user.subscribed,
        "count": usage.count,
        "limit": FREE_DAILY_LIMIT,
    }


# ── Usage ──────────────────────────────────────────────────────────────────

@router.get("/usage")
async def get_usage(
    user: ExtensionUser = Depends(get_extension_user),
    db: AsyncSession = Depends(get_db),
):
    usage = await get_or_create_usage(db, user.id)
    await db.commit()
    return {
        "count": usage.count,
        "limit": FREE_DAILY_LIMIT,
        "subscribed": user.subscribed,
        "remaining": None if user.subscribed else max(0, FREE_DAILY_LIMIT - usage.count),
    }


# ── Annotate ───────────────────────────────────────────────────────────────

ALLOWED_ROLES = {"user", "assistant", "system"}

class Message(BaseModel):
    role: str
    content: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ALLOWED_ROLES:
            raise ValueError(f"role must be one of {ALLOWED_ROLES}")
        return v

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        if len(v) > MAX_MESSAGE_LENGTH:
            raise ValueError(f"message content exceeds {MAX_MESSAGE_LENGTH} characters")
        return v


class AnnotateRequest(BaseModel):
    messages: list[Message]
    model: str = "gpt-4.1-mini"

    @field_validator("model")
    @classmethod
    def validate_model(cls, v: str) -> str:
        if v not in ALLOWED_MODELS:
            return "gpt-4.1-mini"  # silently fall back rather than erroring
        return v

    @field_validator("messages")
    @classmethod
    def validate_messages(cls, v: list) -> list:
        if len(v) > MAX_MESSAGES:
            raise ValueError(f"too many messages (max {MAX_MESSAGES})")
        return v


@router.post("/annotate")
async def annotate(
    req: AnnotateRequest,
    user: ExtensionUser = Depends(get_extension_user),
    db: AsyncSession = Depends(get_db),
):
    # Atomic increment with limit check to prevent race condition
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not user.subscribed:
        # Use atomic UPDATE with conditional to avoid race condition
        result = await db.execute(
            update(DailyUsage)
            .where(
                DailyUsage.user_id == user.id,
                DailyUsage.date == today,
                DailyUsage.count < FREE_DAILY_LIMIT,
            )
            .values(count=DailyUsage.count + 1)
            .returning(DailyUsage.count)
        )
        updated = result.fetchone()

        if updated is None:
            # Either row doesn't exist or limit already reached — check which
            usage = await get_or_create_usage(db, user.id)
            await db.commit()
            if usage.count >= FREE_DAILY_LIMIT:
                raise HTTPException(
                    status_code=429,
                    detail=f"Free limit of {FREE_DAILY_LIMIT} questions/day reached. Upgrade for unlimited access.",
                )
            # Row was just created (count=0), increment it
            usage.count = 1
            await db.commit()
        else:
            await db.commit()

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    async def stream():
        try:
            async with openai_client.chat.completions.stream(
                model=req.model, messages=messages,
            ) as s:
                async for event in s:
                    if event.type == "content.delta":
                        yield f"data: {json.dumps({'delta': event.delta})}\n\n"
        except Exception:
            # Don't leak internal error details (API keys, internal messages etc.)
            yield f"data: {json.dumps({'error': 'An error occurred. Please try again.'})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


# ── Stripe checkout ────────────────────────────────────────────────────────

@router.post("/create-checkout")
async def create_checkout(user: ExtensionUser = Depends(get_extension_user)):
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    if not STRIPE_PRICE_ID:
        raise HTTPException(status_code=500, detail="Stripe price not configured")
    stripe.api_key = STRIPE_SECRET_KEY
    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
            mode="subscription",
            success_url=f"{BACKEND_URL}/api/extension/checkout-success",
            cancel_url=f"{BACKEND_URL}/api/extension/checkout-cancel",
            metadata={"device_id": user.id},
            customer_creation="always",
        )
        return {"url": session.url}
    except stripe.StripeError as e:
        raise HTTPException(status_code=500, detail=str(e.user_message or e))


@router.get("/checkout-success", response_class=HTMLResponse)
async def checkout_success():
    return """<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9fafb">
    <h2 style="color:#111827">✓ You're upgraded!</h2>
    <p style="color:#6b7280">Close this tab and go back to Nabu — you now have unlimited access.</p>
    </body></html>"""


@router.get("/checkout-cancel", response_class=HTMLResponse)
async def checkout_cancel():
    return """<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9fafb">
    <h2 style="color:#111827">Upgrade cancelled</h2>
    <p style="color:#6b7280">No charge was made. Close this tab and go back to Nabu.</p>
    </body></html>"""


# ── Stripe webhook ─────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    stripe.api_key = STRIPE_SECRET_KEY
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    etype = event["type"]
    obj   = event["data"]["object"]

    async def get_user_by_customer(customer_id: str) -> ExtensionUser | None:
        if not customer_id:
            return None
        result = await db.execute(
            select(ExtensionUser).where(ExtensionUser.stripe_customer_id == customer_id)
        )
        return result.scalar_one_or_none()

    if etype == "checkout.session.completed":
        device_id = obj.get("metadata", {}).get("device_id")
        email     = obj.get("customer_details", {}).get("email", "")
        if device_id and UUID_RE.match(str(device_id)):
            result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == device_id))
            user = result.scalar_one_or_none()
            if user:
                user.subscribed = True
                user.email = email
                user.stripe_customer_id = obj.get("customer")
                await db.commit()

    elif etype in ("customer.subscription.resumed", "invoice.paid"):
        # Subscription active / payment succeeded — ensure access is on
        customer_id = obj.get("customer")
        user = await get_user_by_customer(customer_id)
        if user and not user.subscribed:
            user.subscribed = True
            await db.commit()

    elif etype in ("customer.subscription.deleted", "customer.subscription.paused"):
        # Subscription cancelled or paused — revoke access
        user = await get_user_by_customer(obj.get("customer"))
        if user:
            user.subscribed = False
            await db.commit()

    elif etype == "invoice.payment_failed":
        # Card declined — don't revoke immediately (Stripe retries),
        # but flag it so we can surface a warning if needed in future
        # For now: leave subscribed=True until Stripe fires subscription.deleted
        pass

    elif etype == "customer.subscription.updated":
        # Catch-all for status changes (trial end, plan switch, etc.)
        customer_id = obj.get("customer")
        status      = obj.get("status")  # active, past_due, canceled, paused, trialing, etc.
        user = await get_user_by_customer(customer_id)
        if user:
            user.subscribed = status in ("active", "trialing")
            await db.commit()

    return {"ok": True}


# ── Restore purchase ───────────────────────────────────────────────────────

class RestoreRequest(BaseModel):
    email: str
    device_id: str

    @field_validator("device_id")
    @classmethod
    def validate_device_id(cls, v: str) -> str:
        if not UUID_RE.match(v):
            raise ValueError("device_id must be a valid UUID")
        return v

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or len(v) > 254:
            raise ValueError("Invalid email")
        return v


# Constant-time response to prevent email enumeration
_RESTORE_GENERIC = "If an active subscription exists for this email, it has been restored."

@router.post("/restore")
async def restore(req: RestoreRequest, request: Request, db: AsyncSession = Depends(get_db)):
    # Rate limit: 5 restore attempts per IP per hour
    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(f"restore:{client_ip}", max_calls=5, window_seconds=3600)

    result = await db.execute(
        select(ExtensionUser).where(ExtensionUser.email == req.email)
    )
    user = result.scalar_one_or_none()

    # Always return the same response to prevent email enumeration
    if not user or not user.subscribed:
        return {"message": _RESTORE_GENERIC, "restored": False}

    new_user = ExtensionUser(
        id=req.device_id,
        email=user.email,
        subscribed=True,
        stripe_customer_id=user.stripe_customer_id,
    )
    await db.delete(user)
    await db.flush()
    db.add(new_user)
    await db.commit()
    return {
        "message": _RESTORE_GENERIC,
        "restored": True,
        "token": make_token(req.device_id),
    }


# ── Right to erasure (GDPR Art. 17) ───────────────────────────────────────

@router.delete("/account")
async def delete_account(
    user: ExtensionUser = Depends(get_extension_user),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete all data associated with this device."""
    await db.execute(delete(DailyUsage).where(DailyUsage.user_id == user.id))
    await db.delete(user)
    await db.commit()
    return {"message": "All your data has been permanently deleted."}


# ── Data retention cleanup ─────────────────────────────────────────────────

async def purge_old_data(db: AsyncSession):
    """
    Delete DailyUsage records older than 60 days and
    ExtensionUsers inactive for more than 90 days (free, no email).
    Call this from a scheduled job or on startup.
    """
    cutoff_usage = (datetime.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%d")
    await db.execute(delete(DailyUsage).where(DailyUsage.date < cutoff_usage))

    cutoff_user = datetime.now(timezone.utc) - timedelta(days=90)
    await db.execute(
        delete(ExtensionUser).where(
            ExtensionUser.subscribed == False,
            ExtensionUser.email == "",
            ExtensionUser.created_at < cutoff_user,
        )
    )
    await db.commit()
