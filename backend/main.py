"""Rooftop Rush API: a tiny leaderboard service built with FastAPI.

Storage:
  - Local testing: a SQLite file (scores.db) is created automatically.
  - Deployed: set the DATABASE_URL environment variable to a Postgres URL
    (for example a free Neon database) so scores survive restarts.

Environment variables (all optional):
  DATABASE_URL     Postgres connection string
  ALLOWED_ORIGINS  comma separated site addresses allowed to call the API
  BLOCKED_WORDS    extra comma separated words that may not appear in names
"""
import os
import re
import sqlite3
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
DB_PATH = os.getenv("DB_PATH", "scores.db")
ORIGINS = [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# The game's top speed is about 7.3 px/frame * 60 fps / 10 px per metre = 44 m/s.
MAX_SPEED_MPS = 45
RATE_LIMIT = 6       # score posts allowed per IP per minute
PH = "%s" if USE_PG else "?"   # SQL placeholder style

# "Today" and "This week" are rolling windows (the last 24 hours / 7 days).
PERIODS = {"all": 0, "week": 7 * 24 * 3600, "day": 24 * 3600}

if USE_PG:
    import psycopg


# ---------------------------------------------------------------- names
# Words that may not appear anywhere in a name (checked after turning 0->o, 1->i, 3->e, 4->a, 5->s, 7->t).
BLOCKED_SUBSTRINGS = {
    "fuck", "shit", "bitch", "cunt", "whore", "slut", "nazi", "hitler", "porn", "rapist", "pedo", "dildo",
}
# Short words that are only blocked when they are the whole name (so "Class" or "Essex" stay fine).
BLOCKED_EXACT = {"sex", "ass", "dick", "cock", "pussy", "anus", "admin", "mod", "moderator", "staff"}
for _w in os.getenv("BLOCKED_WORDS", "").split(","):
    _w = re.sub(r"[^a-z]", "", _w.strip().lower())
    if len(_w) >= 3:
        BLOCKED_SUBSTRINGS.add(_w)

_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"})


def is_blocked(name: str) -> bool:
    flat = re.sub(r"[^a-z]", "", name.lower().translate(_LEET))
    return flat in BLOCKED_EXACT or any(word in flat for word in BLOCKED_SUBSTRINGS)


# ---------------------------------------------------------------- database
@contextmanager
def db():
    conn = psycopg.connect(DATABASE_URL) if USE_PG else sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    pk = "BIGSERIAL PRIMARY KEY" if USE_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    with db() as conn:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS scores ("
            f"id {pk}, name TEXT NOT NULL, distance INTEGER NOT NULL, created_at BIGINT NOT NULL)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_scores_distance ON scores (distance DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_scores_created ON scores (created_at)")


def cutoff_for(period: str) -> int:
    span = PERIODS[period]
    return int(time.time()) - span if span else 0


def rank_for(conn, distance: int, cutoff: int) -> int:
    """1 + how many different players (names ignoring upper/lower case) beat this distance."""
    row = conn.execute(
        f"SELECT COUNT(*) FROM ("
        f"SELECT LOWER(name) AS n, MAX(distance) AS best FROM scores WHERE created_at >= {PH} GROUP BY LOWER(name)"
        f") t WHERE best > {PH}",
        (cutoff, distance),
    ).fetchone()
    return row[0] + 1


_ready = False


def ensure_db():
    """Create the table on first use (and retry later if the database was unreachable at startup)."""
    global _ready
    if not _ready:
        init_db()
        _ready = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        ensure_db()
    except Exception as exc:   # keep the server up so /health/db can show what is wrong
        print("Database setup failed:", type(exc).__name__, exc, flush=True)
    yield


app = FastAPI(title="Rooftop Rush API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ---- simple in-memory rate limit (resets if the server restarts) ----
_hits = defaultdict(deque)
_lock = threading.Lock()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate(ip: str):
    now = time.time()
    with _lock:
        if len(_hits) > 5000:
            _hits.clear()
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many scores posted. Wait a minute and try again.")
        q.append(now)


class ScoreIn(BaseModel):
    name: str
    distance: int = Field(ge=1, le=100000)
    duration_ms: int = Field(ge=1000, le=6 * 3600 * 1000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = re.sub(r"\s+", " ", v).strip()
        if not re.fullmatch(r"[A-Za-z0-9 _.\-]{1,12}", v):
            raise ValueError("Name must be 1 to 12 letters, numbers, spaces, _ . or -")
        return v


@app.get("/")
def root():
    return {"name": "Rooftop Rush API", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok", "db": "postgres" if USE_PG else "sqlite"}


@app.get("/health/db")
def health_db():
    """Open this address in a browser to check the database connection."""
    kind = "postgres" if USE_PG else "sqlite"
    try:
        ensure_db()
        with db() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok", "db": kind}
    except Exception as exc:
        return {"status": "error", "db": kind, "error": type(exc).__name__}


@app.get("/api/leaderboard")
def leaderboard(limit: int = Query(10, ge=1, le=50), period: str = "all"):
    """Best score per player. period: all, week (last 7 days) or day (last 24 hours)."""
    if period not in PERIODS:
        raise HTTPException(status_code=400, detail="period must be all, week or day")
    ensure_db()
    with db() as conn:
        rows = conn.execute(
            f"SELECT name, distance FROM ("
            f"SELECT name, distance, ROW_NUMBER() OVER ("
            f"PARTITION BY LOWER(name) ORDER BY distance DESC, created_at ASC) AS rn "
            f"FROM scores WHERE created_at >= {PH}"
            f") t WHERE rn = 1 ORDER BY distance DESC, name ASC LIMIT {PH}",
            (cutoff_for(period), limit),
        ).fetchall()
    return [{"name": r[0], "distance": r[1]} for r in rows]


@app.post("/api/scores")
def submit_score(score: ScoreIn, request: Request):
    check_rate(client_ip(request))
    if is_blocked(score.name):
        raise HTTPException(status_code=400, detail="Please pick a different name.")
    # A run can't cover more ground than top speed allows for its length.
    if score.distance > score.duration_ms / 1000 * MAX_SPEED_MPS + 30:
        raise HTTPException(status_code=400, detail="That score doesn't match the run time.")
    ensure_db()
    with db() as conn:
        conn.execute(
            f"INSERT INTO scores (name, distance, created_at) VALUES ({PH}, {PH}, {PH})",
            (score.name, score.distance, int(time.time())),
        )
        return {
            "ok": True,
            "rank": rank_for(conn, score.distance, 0),
            "rank_week": rank_for(conn, score.distance, cutoff_for("week")),
            "rank_day": rank_for(conn, score.distance, cutoff_for("day")),
        }
