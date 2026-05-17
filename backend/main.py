import asyncio
import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from extension_routes import router as ext_router, purge_old_data
from pages_routes import router as pages_router
from db import AsyncSessionLocal, create_tables

# Scrub IP addresses from uvicorn access logs — IPs are personal data under GDPR
logging.getLogger("uvicorn.access").handlers = []

PURGE_INTERVAL_SECONDS = 24 * 60 * 60  # daily


async def _purge_loop():
    while True:
        try:
            async with AsyncSessionLocal() as session:
                await purge_old_data(session)
        except Exception as e:
            logging.warning("purge_old_data failed: %s", e)
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_tables()
    purge_task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        purge_task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)  # disable public API docs

# Calls from the extension's content script use host_permissions and bypass CORS,
# so wide-open CORS is unnecessary. Allow only the landing/privacy origin and
# any chrome-extension:// installation.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-z]{32}$|^https://nabu-extension-production\.up\.railway\.app$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(pages_router)
app.include_router(ext_router)
app.mount("/static", StaticFiles(directory="static"), name="static")
