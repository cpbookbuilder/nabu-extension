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
from pages_routes import BASE_CSS, NAV, FOOTER

router = APIRouter(prefix="/api/extension")
openai_client = AsyncOpenAI()

FREE_DAILY_LIMIT      = 5
JWT_ALGORITHM         = "HS256"
JWT_EXPIRE_DAYS       = 30
STRIPE_SECRET_KEY     = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID       = os.environ.get("STRIPE_PRICE_ID", "")
BACKEND_URL           = os.environ.get("BACKEND_URL", "https://nabu-extension-production.up.railway.app")

JWT_SECRET = os.environ.get("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET is not set. Generate one with `openssl rand -hex 32` and "
        "set it as an env var before starting the backend."
    )

# Single server-side model. Hardcoded so the extension cannot influence cost
# by sending a more expensive model in the request.
OPENAI_MODEL = "gpt-5-nano"

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
    result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == req.device_id))
    user = result.scalar_one_or_none()
    if not user:
        # Only rate-limit actual new registrations (not token refreshes for existing devices)
        client_ip = request.client.host if request.client else "unknown"
        check_rate_limit(f"register:{client_ip}", max_calls=10, window_seconds=3600)
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

    @field_validator("messages")
    @classmethod
    def validate_messages(cls, v: list) -> list:
        if len(v) > MAX_MESSAGES:
            raise ValueError(f"too many messages (max {MAX_MESSAGES})")
        return v

    model_config = {"extra": "ignore"}  # silently drop any legacy `model` field from old extension versions


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
                model=OPENAI_MODEL, messages=messages,
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
        )
        return {"url": session.url}
    except stripe.StripeError as e:
        raise HTTPException(status_code=500, detail=str(e.user_message or e))


@router.post("/manage-subscription")
async def manage_subscription(user: ExtensionUser = Depends(get_extension_user)):
    """Return a Stripe Customer Portal URL where the user can cancel, update
    payment method, view invoices, etc."""
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    if not user.stripe_customer_id:
        raise HTTPException(status_code=400, detail="No subscription found for this device.")
    stripe.api_key = STRIPE_SECRET_KEY
    try:
        session = stripe.billing_portal.Session.create(
            customer=user.stripe_customer_id,
            return_url=f"{BACKEND_URL}/api/extension/portal-return",
        )
        return {"url": session.url}
    except stripe.StripeError as e:
        raise HTTPException(status_code=500, detail=str(e.user_message or e))


def _branded_page(*, icon: str, icon_color: str, title: str, body: str, auto_close: bool) -> str:
    """Render a Nabu-branded full-page response shown after Stripe redirects.

    Uses the shared NAV + FOOTER from pages_routes so this is visually
    consistent with the landing and privacy pages.

    auto_close: try window.close() after 3s with countdown; show manual fallback if blocked.
    """
    countdown_html = """
      <p id="cd" style="margin-top:20px;font-size:13px;color:#64748b;">
        This tab will close in <span id="cd-n">3</span>…
      </p>
      <script>
        let n = 3;
        const cdEl = document.getElementById('cd-n');
        const cdP  = document.getElementById('cd');
        const tick = setInterval(() => {
          n -= 1;
          if (n > 0) { cdEl.textContent = n; return; }
          clearInterval(tick);
          window.close();
          // If Chrome blocks close (e.g. tab not opened by script), show fallback.
          setTimeout(() => { cdP.textContent = 'You can close this tab now.'; }, 300);
        }, 1000);
      </script>
    """ if auto_close else ""
    extra_css = f"""
      .card-wrap {{ display: flex; justify-content: center; padding: 60px 24px 40px; }}
      .return-card {{
        max-width: 460px; width: 100%; text-align: center; padding: 40px 32px;
        background: #141720; border: 1px solid #1e2330; border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,.4);
      }}
      .return-card .icon {{
        width: 64px; height: 64px; border-radius: 50%;
        background: {icon_color}; color: #0f1117;
        display: flex; align-items: center; justify-content: center;
        font-size: 36px; font-weight: 800;
        margin: 0 auto 20px;
        animation: pop .35s cubic-bezier(.2,.9,.3,1.4) both;
      }}
      @keyframes pop {{
        0% {{ transform: scale(0); opacity: 0; }}
        100% {{ transform: scale(1); opacity: 1; }}
      }}
      .return-card h1 {{ font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 12px; }}
      .return-card p {{ font-size: 14px; color: #94a3b8; line-height: 1.6; }}
    """
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nabu</title>
  <style>{BASE_CSS}{extra_css}</style>
</head>
<body>
  {NAV}
  <div class="card-wrap">
    <div class="return-card">
      <div class="icon">{icon}</div>
      <h1>{title}</h1>
      <p>{body}</p>
      {countdown_html}
    </div>
  </div>
  {FOOTER}
</body>
</html>"""


@router.get("/portal-return", response_class=HTMLResponse)
async def portal_return():
    return _branded_page(
        icon="✓",
        icon_color="#f6c344",
        title="Subscription updated",
        body="Re-open Nabu from your extension bar to see the latest plan status.",
        auto_close=True,
    )


@router.get("/checkout-success", response_class=HTMLResponse)
async def checkout_success():
    return _branded_page(
        icon="✓",
        icon_color="#81c995",
        title="You're now Pro",
        body=(
            "Unlimited questions are live. Open Nabu from your extension bar to start."
            "<br><br>"
            "<span style='color:#cbd5e1;font-size:13px;font-weight:600;'>How to cancel anytime:</span>"
            "<ol style='text-align:left;color:#94a3b8;font-size:13px;margin:8px auto 0;max-width:280px;padding-left:20px;line-height:1.7;'>"
            "<li>Click the <strong>Nabu</strong> icon in your extension bar.</li>"
            "<li>Tap <strong>Manage subscription</strong> in the popup.</li>"
            "<li>Click <strong>Cancel plan</strong> in the portal that opens.</li>"
            "</ol>"
            "<span style='display:block;margin-top:14px;color:#64748b;font-size:12px;'>"
            "No cancellation fees. Access continues until the end of the billing period."
            "</span>"
        ),
        auto_close=False,
    )


@router.get("/checkout-cancel", response_class=HTMLResponse)
async def checkout_cancel():
    return _branded_page(
        icon="×",
        icon_color="#3c4043",
        title="Upgrade cancelled",
        body="No charge was made. You're still on the Free plan.",
        auto_close=True,
    )


# ── Stripe webhook ─────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    stripe.api_key = STRIPE_SECRET_KEY
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        # construct_event verifies the signature. We discard the returned
        # StripeObject and parse the raw JSON ourselves — in Stripe SDK ≥12,
        # StripeObject no longer inherits from dict, so `.get()` raises
        # AttributeError. Plain dicts keep the handler simple.
        stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    event = json.loads(payload)
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
        email     = obj.get("customer_details", {}).get("email") or obj.get("customer_email", "") or ""
        if device_id and UUID_RE.match(str(device_id)):
            result = await db.execute(select(ExtensionUser).where(ExtensionUser.id == device_id))
            user = result.scalar_one_or_none()
            if user:
                user.subscribed = True
                user.email = email
                user.stripe_customer_id = obj.get("customer")
                user.cancelled_at = None
                await db.commit()

    elif etype in ("customer.subscription.resumed", "invoice.paid"):
        # Subscription active / payment succeeded — ensure access is on and
        # clear any prior cancellation timestamp so the 30-day purge doesn't fire.
        customer_id = obj.get("customer")
        user = await get_user_by_customer(customer_id)
        if user:
            changed = False
            if not user.subscribed:
                user.subscribed = True
                changed = True
            if user.cancelled_at is not None:
                user.cancelled_at = None
                changed = True
            if changed:
                await db.commit()

    elif etype in ("customer.subscription.deleted", "customer.subscription.paused"):
        # Subscription cancelled or paused — revoke access and start the
        # 30-day clock for email/record retention.
        user = await get_user_by_customer(obj.get("customer"))
        if user:
            user.subscribed = False
            if user.cancelled_at is None:
                user.cancelled_at = datetime.now(timezone.utc)
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
            now_active = status in ("active", "trialing")
            user.subscribed = now_active
            if now_active:
                user.cancelled_at = None
            elif status in ("canceled", "paused", "incomplete_expired") and user.cancelled_at is None:
                user.cancelled_at = datetime.now(timezone.utc)
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
    source_user = result.scalar_one_or_none()

    # Always return the same response to prevent email enumeration
    if not source_user or not source_user.subscribed:
        return {"message": _RESTORE_GENERIC, "restored": False}

    # If the new device is the same as the source, just return a fresh token
    if source_user.id == req.device_id:
        return {
            "message": _RESTORE_GENERIC,
            "restored": True,
            "token": make_token(req.device_id),
        }

    # Check if target device already exists — if so, transfer subscription to it
    target_result = await db.execute(
        select(ExtensionUser).where(ExtensionUser.id == req.device_id)
    )
    target_user = target_result.scalar_one_or_none()

    if target_user:
        target_user.subscribed = True
        target_user.email = source_user.email
        target_user.stripe_customer_id = source_user.stripe_customer_id
    else:
        target_user = ExtensionUser(
            id=req.device_id,
            email=source_user.email,
            subscribed=True,
            stripe_customer_id=source_user.stripe_customer_id,
        )
        db.add(target_user)

    # Detach subscription from the source device (don't delete — preserves usage history,
    # avoids FK violations on DailyUsage rows)
    source_user.subscribed = False
    source_user.email = ""
    source_user.stripe_customer_id = None

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
    """Permanently delete all data associated with this device.

    Also cancels the Stripe subscription if present, so the user is not billed
    after their record is gone.
    """
    # Three-state outcome for the popup:
    #   None  → user had no Stripe customer (free tier) — nothing to do
    #   True  → at least one active subscription was cancelled
    #   False → had a Stripe customer but the cancel call failed; user must follow up
    stripe_cancelled: bool | None = None
    if user.stripe_customer_id and STRIPE_SECRET_KEY:
        stripe.api_key = STRIPE_SECRET_KEY
        try:
            subs = stripe.Subscription.list(customer=user.stripe_customer_id, status="active", limit=10)
            for sub in subs.auto_paging_iter():
                stripe.Subscription.delete(sub.id)
            stripe_cancelled = True
        except stripe.StripeError:
            # Don't block deletion if Stripe call fails — user still gets DB deletion.
            # Webhook + manual reconciliation will catch leftover subscriptions.
            stripe_cancelled = False

    await db.execute(delete(DailyUsage).where(DailyUsage.user_id == user.id))
    await db.delete(user)
    await db.commit()
    return {
        "message": "All your data has been permanently deleted.",
        "stripe_cancelled": stripe_cancelled,
    }


# ── Data retention cleanup ─────────────────────────────────────────────────

# Aligned with /privacy: 30-day inactivity window for non-subscribers,
# 30-day post-cancellation cleanup for emails.
RETENTION_DAYS = 30


async def purge_old_data(db: AsyncSession):
    """Honor the published 30-day retention policy.

    Three classes of records are eligible for deletion:
      1. DailyUsage rows older than RETENTION_DAYS.
      2. Free, unidentified ExtensionUsers (no email, never subscribed) inactive
         past RETENTION_DAYS — typical free-tier abandonment.
      3. Cancelled subscribers (any user with cancelled_at set) past
         RETENTION_DAYS since cancellation — the policy promise that subscriber
         emails are deleted within 30 days of cancellation.
    """
    cutoff_usage = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%d")
    await db.execute(delete(DailyUsage).where(DailyUsage.date < cutoff_usage))

    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)

    # Class 2: free + unidentified + inactive
    await db.execute(
        delete(ExtensionUser).where(
            ExtensionUser.subscribed == False,
            ExtensionUser.email == "",
            ExtensionUser.cancelled_at.is_(None),
            ExtensionUser.created_at < cutoff,
        )
    )

    # Class 3: cancelled subscribers past the 30-day grace window. Cascade-style:
    # also drop their DailyUsage rows so the FK does not block the user delete.
    cancelled_ids = (await db.execute(
        select(ExtensionUser.id).where(
            ExtensionUser.cancelled_at.is_not(None),
            ExtensionUser.cancelled_at < cutoff,
        )
    )).scalars().all()
    if cancelled_ids:
        await db.execute(delete(DailyUsage).where(DailyUsage.user_id.in_(cancelled_ids)))
        await db.execute(delete(ExtensionUser).where(ExtensionUser.id.in_(cancelled_ids)))

    await db.commit()
