import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar

from dotenv import load_dotenv
load_dotenv()

# ── Fail-fast env validation ──────────────────────────────────────────────
# Catches misconfigured deploys at boot instead of surfacing as "An error
# occurred" later. STRIPE_* are intentionally optional — billing is only
# wired up if a SECRET_KEY is present.
_REQUIRED_ENV = ("DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY")
_missing = [v for v in _REQUIRED_ENV if not os.environ.get(v)]
if _missing:
    raise RuntimeError(
        f"Missing required env vars: {', '.join(_missing)}. "
        "See README.md → Local development for setup."
    )

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

# ── Structured logging + request ID ───────────────────────────────────────
# Every request gets a UUID. The ID is set in a ContextVar so module-level
# loggers anywhere downstream pick it up via the RequestIdFilter, and is
# echoed back in the X-Request-ID response header for client-side correlation.
_request_id: ContextVar[str] = ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get()
        return True


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s req=%(request_id)s %(message)s",
    force=True,
)
for h in logging.getLogger().handlers:
    h.addFilter(RequestIdFilter())

# Scrub IP addresses from uvicorn access logs — IPs are personal data under GDPR
logging.getLogger("uvicorn.access").handlers = []
logger = logging.getLogger("nabu")

from admin_routes import router as admin_router
from extension_routes import router as ext_router, purge_old_data
from pages_routes import router as pages_router
from db import AsyncSessionLocal, create_tables, engine

PURGE_INTERVAL_SECONDS = 24 * 60 * 60  # daily


async def _purge_loop():
    while True:
        try:
            async with AsyncSessionLocal() as session:
                await purge_old_data(session)
        except Exception as e:
            logger.warning("purge_old_data failed: %s", e)
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)


async def _create_tables_with_retry():
    # On Railway, a brief Postgres unavailability at boot used to kill the whole
    # app (lifespan raises → uvicorn exits → 502s). Retry with backoff before
    # giving up; if all attempts fail, log loud but keep serving so /healthz
    # can report the unhealthy state instead of the router 502-ing.
    delays = (1, 2, 4, 8, 16)
    for attempt, delay in enumerate(delays, start=1):
        try:
            await create_tables()
            if attempt > 1:
                logger.info("create_tables succeeded on attempt %d", attempt)
            return
        except Exception as e:
            logger.warning("create_tables attempt %d/%d failed: %s", attempt, len(delays), e)
            if attempt < len(delays):
                await asyncio.sleep(delay)
    logger.error("create_tables failed after %d attempts; serving with /healthz=503", len(delays))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _create_tables_with_retry()
    purge_task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        purge_task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)  # disable public API docs


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        token = _request_id.set(rid)
        try:
            response = await call_next(request)
        finally:
            _request_id.reset(token)
        response.headers["X-Request-ID"] = rid
        return response


app.add_middleware(RequestIdMiddleware)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Liveness + readiness probe. 200 if DB reachable, 503 otherwise.

    Used by Railway/uptime monitors and by `_create_tables_with_retry` to
    surface boot-time DB outages without 502-ing the whole router.
    """
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as e:
        logger.warning("/healthz db ping failed: %s", e)
        return JSONResponse(
            status_code=503,
            content={"status": "db_unavailable", "detail": str(e)[:200]},
        )

# MV3 content scripts make fetches with the *host page's* origin (e.g.
# https://gemini.google.com), not chrome-extension://, so restricting CORS to
# the extension origin locks the extension out of every webpage. Allow any
# origin — the JWT bearer token is the actual auth boundary, and credentials
# are off by default so cookies can't ride along.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(pages_router)
app.include_router(ext_router)
app.include_router(admin_router)
app.mount("/static", StaticFiles(directory="static"), name="static")
