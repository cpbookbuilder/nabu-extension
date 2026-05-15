from contextlib import asynccontextmanager
from dotenv import load_dotenv
load_dotenv()

import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from extension_routes import router as ext_router
from pages_routes import router as pages_router
from db import create_tables

# Scrub IP addresses from uvicorn access logs — IPs are personal data under GDPR
logging.getLogger("uvicorn.access").handlers = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_tables()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)  # disable public API docs

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pages_router)
app.include_router(ext_router)
app.mount("/static", StaticFiles(directory="static"), name="static")
