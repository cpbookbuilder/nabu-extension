import json
import os
from datetime import datetime, timezone

import jwt
import stripe
from fastapi import APIRouter, Depends, HTTPException, Header, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from db_models import ExtensionUser, DailyUsage

router = APIRouter(prefix="/api/extension")
openai_client = AsyncOpenAI()

FREE_DAILY_LIMIT      = 10
JWT_SECRET            = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM         = "HS256"
STRIPE_SECRET_KEY     = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID       = os.environ.get("STRIPE_PRICE_ID", "")
BACKEND_URL           = os.environ.get("BACKEND_URL", "https://annotate-ai-production.up.railway.app")

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


# ── JWT ────────────────────────────────────────────────────────────────────

def make_token(device_id: str) -> str:
    return jwt.encode({"sub": device_id}, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_extension_user(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> ExtensionUser:
    try:
        token = authorization.removeprefix("Bearer ").strip()
        device_id = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])["sub"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == device_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Device not registered")
    return user


# ── Usage helper ───────────────────────────────────────────────────────────

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


# ── Register (device ID → JWT, zero user interaction) ─────────────────────

class RegisterRequest(BaseModel):
    device_id: str


@router.post("/register")
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    if not req.device_id or len(req.device_id) < 8:
        raise HTTPException(status_code=400, detail="Invalid device ID")
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

class Message(BaseModel):
    role: str
    content: str

class AnnotateRequest(BaseModel):
    messages: list[Message]
    model: str = "gpt-4o-mini"


@router.post("/annotate")
async def annotate(
    req: AnnotateRequest,
    user: ExtensionUser = Depends(get_extension_user),
    db: AsyncSession = Depends(get_db),
):
    usage = await get_or_create_usage(db, user.id)
    if not user.subscribed and usage.count >= FREE_DAILY_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Free limit of {FREE_DAILY_LIMIT} questions/day reached. Upgrade for unlimited access.",
        )
    usage.count += 1
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
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


# ── Stripe checkout ────────────────────────────────────────────────────────

@router.post("/create-checkout")
async def create_checkout(user: ExtensionUser = Depends(get_extension_user)):
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    stripe.api_key = STRIPE_SECRET_KEY
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

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        device_id = session.get("metadata", {}).get("device_id")
        email = session.get("customer_details", {}).get("email", "")
        if device_id:
            result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == device_id))
            user = result.scalar_one_or_none()
            if user:
                user.subscribed = True
                user.email = email
                user.stripe_customer_id = session.get("customer")
                await db.commit()

    elif event["type"] in ("customer.subscription.deleted", "customer.subscription.paused"):
        customer_id = event["data"]["object"].get("customer")
        if customer_id:
            result = await db.execute(
                select(ExtensionUser).where(ExtensionUser.stripe_customer_id == customer_id)
            )
            user = result.scalar_one_or_none()
            if user:
                user.subscribed = False
                await db.commit()

    return {"ok": True}


# ── Restore purchase ───────────────────────────────────────────────────────

class RestoreRequest(BaseModel):
    email: str
    device_id: str


@router.post("/restore")
async def restore(req: RestoreRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ExtensionUser).where(ExtensionUser.email == req.email)
    )
    user = result.scalar_one_or_none()
    if not user or not user.subscribed:
        raise HTTPException(status_code=404, detail="No active subscription found for this email.")

    # Move subscription to new device
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
    return {"token": make_token(req.device_id), "subscribed": True}
