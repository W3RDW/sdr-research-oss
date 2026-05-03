import asyncio
import os
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator

from .database import engine, Base
from .routers import admin, aprs, files, repeaters, search, stats, waveform
from .services.indexer import run_indexer
from .services.repeater import run_repeater_sync


class RateLimitMiddleware(BaseHTTPMiddleware):
    """In-memory per-IP rate limiter. No external dependencies needed."""

    def __init__(self, app, requests_per_minute: int = 120):
        super().__init__(app)
        self.rpm = requests_per_minute
        self._requests: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request, call_next):
        # Don't rate limit health checks or metrics
        if request.url.path in ("/api/v1/health", "/metrics"):
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        now = time.time()

        # Clean old entries
        self._requests[client_ip] = [
            t for t in self._requests[client_ip] if now - t < 60
        ]

        if len(self._requests[client_ip]) >= self.rpm:
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again in a minute."},
                headers={"X-RateLimit-Remaining": "0"},
            )

        self._requests[client_ip].append(now)
        response = await call_next(request)
        remaining = self.rpm - len(self._requests[client_ip])
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    # Incremental migrations
    from sqlalchemy import text as _t
    with engine.connect() as _conn:
        _conn.execute(_t("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS signal_db FLOAT"))
        _conn.execute(_t("ALTER TABLE recordings ADD COLUMN IF NOT EXISTS source_sdr VARCHAR(30)"))
        _conn.execute(_t("ALTER TABLE repeaters ADD COLUMN IF NOT EXISTS last_heard TIMESTAMP"))
        _conn.execute(_t("CREATE INDEX IF NOT EXISTS ix_recordings_mode_ts ON recordings (mode, timestamp DESC)"))
        # Migrate ai_tags from TEXT to JSONB
        _conn.execute(_t("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'recordings' AND column_name = 'ai_tags' AND data_type = 'text'
              ) THEN
                ALTER TABLE recordings ADD COLUMN ai_tags_jsonb JSONB;
                UPDATE recordings SET ai_tags_jsonb =
                  CASE WHEN ai_tags IS NOT NULL AND ai_tags != ''
                    THEN ai_tags::jsonb
                    ELSE NULL
                  END;
                ALTER TABLE recordings DROP COLUMN ai_tags;
                ALTER TABLE recordings RENAME COLUMN ai_tags_jsonb TO ai_tags;
                CREATE INDEX IF NOT EXISTS ix_recordings_ai_tags ON recordings USING GIN (ai_tags);
              END IF;
            END $$;
        """))
        _conn.commit()
    indexer_task = asyncio.create_task(run_indexer())
    repeater_task = asyncio.create_task(run_repeater_sync())
    yield
    for task in (indexer_task, repeater_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="SDR Viewer API",
    description="API for browsing and streaming SDR recordings",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(RateLimitMiddleware, requests_per_minute=120)

_cors_env = os.getenv("CORS_ORIGINS", "").strip()
if _cors_env:
    _cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
else:
    _cors_origins = ["http://localhost:3000", "http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router, prefix="/api/v1/files", tags=["files"])
app.include_router(search.router, prefix="/api/v1/search", tags=["search"])
app.include_router(waveform.router, prefix="/api/v1/waveform", tags=["waveform"])
app.include_router(repeaters.router, prefix="/api/v1/repeaters", tags=["repeaters"])
app.include_router(aprs.router, prefix="/api/v1/aprs", tags=["aprs"])
app.include_router(stats.router, prefix="/api/v1/stats", tags=["stats"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])

Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}
