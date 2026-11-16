"""Rooftop Rush API: a small leaderboard service built with FastAPI.

Storage:
  - Local testing: a SQLite file (scores.db) is created automatically.
  - Deployed: set DATABASE_URL to your Supabase Postgres connection string so
    scores survive restarts. Use the "Session pooler" or "Transaction pooler"
    string from Supabase > Project Settings > Database > Connection string.
    If your password contains special characters (@ : / # ?) URL-encode them.

Environment variables (all optional unless marked):
  DATABASE_URL        Postgres connection string (Supabase)
  ALLOWED_ORIGINS     comma separated site addresses allowed to call the API
  RUN_SECRET          (set this in production) long random text used to sign run tokens.
                      If it is missing, a random one is made at startup, which means
                      tokens from before a restart stop working.
  STRICT_MODE         "1" = scores must carry a valid run token and a name secret.
                      Leave at "0" until the updated game.js is deployed, then set to "1".
  TRUSTED_PROXY_HOPS  how many proxies sit in front of this server (0 = old behaviour).
                      Open /health/ip to see what your host sends, then set this.
  BLOCKED_WORDS       extra comma separated words that may not appear in names
"""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
DB_PATH = os.getenv("DB_PATH", "scores.db")
ORIGINS = [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
STRICT = os.getenv("STRICT_MODE", "0").strip() == "1"
TRUSTED_HOPS = int(os.getenv("TRUSTED_PROXY_HOPS", "0") or 0)

if ORIGINS == ["*"]:
    print("WARNING: ALLOWED_ORIGINS is not set, so any website can call this API.", flush=True)

_env_secret = os.getenv("RUN_SECRET", "").strip()
if not _env_secret:
    print("WARNING: RUN_SECRET is not set. Using a temporary one; run tokens reset on every restart.", flush=True)
RUN_SECRET = (_env_secret or secrets.token_hex(32)).encode()

# ---- game constants (keep in sync with frontend/game.js) ----
START_SPEED, MAX_SPEED, RAMP, PX_PER_M = 4.0, 7.0, 0.0004, 10.0   # px/frame, px/frame, per frame, px per metre
FPS = 60
SLACK = 1.15           # allows for the ice-world speed boost
GRACE_S = 15           # seconds of leeway (token request time, network delay, waking server)
MAX_POSTS_PER_RUN = 3  # a run can end up to 3 times (first life + 2 revives)
MAX_RUN_AGE_S = 6 * 3600
LEGACY_MAX_SPEED_MPS = 45   # only used when STRICT_MODE is off and no token is sent

RATE_LIMIT = 6         # score posts allowed per IP (and per name) per minute
RUN_START_LIMIT = 30   # run tokens allowed per IP per minute
LB_CACHE_TTL = 10      # seconds the leaderboard is cached in memory
PH = "%s" if USE_PG else "?"   # SQL placeholder style

# "Today" and "This week" are rolling windows (the last 24 hours / 7 days).
PERIODS = {"all": 0, "week": 7 * 24 * 3600, "day": 24 * 3600}

if USE_PG:
    import psycopg
    DB_ERRORS = (psycopg.Error, sqlite3.Error)
else:
    DB_ERRORS = (sqlite3.Error,)


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
    if USE_PG:
        # prepare_threshold=None is needed for Supabase's pooled connections (pgbouncer),
        # otherwise you get "prepared statement already exists" errors after a few requests.
        conn = psycopg.connect(DATABASE_URL, prepare_threshold=None, connect_timeout=10)
    else:
        conn = sqlite3.connect(DB_PATH)
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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_scores_lname ON scores (LOWER(name), distance DESC)")
        # Who owns which name (a hash of a secret that only that browser knows).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS players ("
            "name_key TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at BIGINT NOT NULL)"
        )
        # One row per run that posted a score, so a run token can only be used a few times.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS runs ("
            "run_id TEXT PRIMARY KEY, uses INTEGER NOT NULL, best INTEGER NOT NULL, created_at BIGINT NOT NULL)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at)")
        if USE_PG:
            # Supabase exposes the public schema through its own web API. Turning on row level
            # security (with no policies) blocks that route. This server connects as the database
            # owner, which is not affected, so the game keeps working.
            for table in ("scores", "players", "runs"):
                try:
                    conn.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
                except Exception as exc:
                    print("Could not enable RLS on", table, type(exc).__name__, flush=True)


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
    """Create the tables on first use (and retry later if the database was unreachable at startup)."""
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


async def db_unavailable(request: Request, exc: Exception):
    print("Database error:", type(exc).__name__, exc, flush=True)
    return JSONResponse(status_code=503, content={"detail": "The leaderboard database is unavailable. Try again soon."})


for _exc_type in DB_ERRORS:
    app.add_exception_handler(_exc_type, db_unavailable)

# ---- simple in-memory rate limit (resets if the server restarts) ----
_hits = defaultdict(deque)
_lock = threading.Lock()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    parts = [p.strip() for p in forwarded.split(",") if p.strip()]
    if parts:
        # The left-most entry can be faked by the player. With TRUSTED_PROXY_HOPS set, count
        # from the right instead (those entries were added by your host's own proxies).
        if TRUSTED_HOPS > 0:
            return parts[max(0, len(parts) - TRUSTED_HOPS)]
        return parts[0]
    return request.client.host if request.client else "unknown"


def check_rate(key: str, limit: int = RATE_LIMIT):
    now = time.time()
    with _lock:
        if len(_hits) > 5000:
            _hits.clear()
        q = _hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(status_code=429, detail="Too many requests. Wait a minute and try again.")
        q.append(now)


# ---- tiny leaderboard cache so refreshing the page can't hammer the database ----
_cache = {}


def cache_get(key):
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    return None


def cache_put(key, value):
    with _lock:
        if len(_cache) > 200:
            _cache.clear()
        _cache[key] = (time.time() + LB_CACHE_TTL, value)


def cache_clear():
    with _lock:
        _cache.clear()


# ---------------------------------------------------------------- run tokens
def max_dist_m(seconds: float) -> float:
    """Furthest a legitimate run could get in this many seconds, using the game's real speed curve."""
    f = max(0.0, seconds) * FPS
    ramp_frames = (MAX_SPEED - START_SPEED) / RAMP        # frames until top speed
    if f <= ramp_frames:
        px = START_SPEED * f + (RAMP / 2) * f * f
    else:
        px = START_SPEED * ramp_frames + (RAMP / 2) * ramp_frames ** 2 + MAX_SPEED * (f - ramp_frames)
    return px / PX_PER_M * SLACK + 20


def _sign(run_id: str, ts: int) -> str:
    return hmac.new(RUN_SECRET, f"{run_id}.{ts}".encode(), hashlib.sha256).hexdigest()[:32]


def make_token() -> str:
    run_id, ts = secrets.token_urlsafe(9), int(time.time())
    return f"{run_id}.{ts}.{_sign(run_id, ts)}"


def read_token(token: str):
    """Return (run_id, started_at) or raise 400."""
    bad = HTTPException(status_code=400, detail="This run could not be verified. Start a new run.")
    parts = (token or "").split(".")
    if len(parts) != 3 or not parts[1].isdigit():
        raise bad
    run_id, ts, sig = parts[0], int(parts[1]), parts[2]
    if not hmac.compare_digest(sig, _sign(run_id, ts)):
        raise bad
    age = time.time() - ts
    if age < -5 or age > MAX_RUN_AGE_S:
        raise bad
    return run_id, ts


# ---------------------------------------------------------------- request models
class ScoreIn(BaseModel):
    name: str
    distance: int = Field(ge=1, le=100000)
    duration_ms: Optional[int] = Field(default=None, ge=1000, le=6 * 3600 * 1000)   # old clients only
    token: Optional[str] = Field(default=None, max_length=120)
    secret: Optional[str] = Field(default=None, max_length=128)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = re.sub(r"\s+", " ", v).strip()
        if not re.fullmatch(r"[A-Za-z0-9 _.\-]{1,12}", v):
            raise ValueError("Name must be 1 to 12 letters, numbers, spaces, _ . or -")
        return v

    @field_validator("secret")
    @classmethod
    def clean_secret(cls, v):
        if v is not None and not re.fullmatch(r"[A-Za-z0-9_\-]{16,128}", v):
            raise ValueError("Invalid device secret.")
        return v


# ---------------------------------------------------------------- routes
@app.get("/")
def root():
    return {"name": "Rooftop Rush API", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok", "db": "postgres" if USE_PG else "sqlite", "strict": STRICT}


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


@app.get("/health/ip")
def health_ip(request: Request):
    """Shows what your host sends, so you can pick the right TRUSTED_PROXY_HOPS value."""
    return {
        "x_forwarded_for": request.headers.get("x-forwarded-for", ""),
        "direct_peer": request.client.host if request.client else None,
        "trusted_proxy_hops": TRUSTED_HOPS,
        "ip_used_for_rate_limit": client_ip(request),
    }


@app.post("/api/run/start")
def run_start(request: Request):
    """Called when a run begins. The signed token lets the server measure the run time itself."""
    check_rate("start:" + client_ip(request), RUN_START_LIMIT)
    return {"token": make_token()}


@app.get("/api/leaderboard")
def leaderboard(limit: int = Query(10, ge=1, le=50), period: str = "all"):
    """Best score per player. period: all, week (last 7 days) or day (last 24 hours)."""
    if period not in PERIODS:
        raise HTTPException(status_code=400, detail="period must be all, week or day")
    key = (period, limit)
    cached = cache_get(key)
    if cached is not None:
        return cached
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
    result = [{"name": r[0], "distance": r[1]} for r in rows]
    cache_put(key, result)
    return result


@app.post("/api/scores")
def submit_score(score: ScoreIn, request: Request):
    check_rate("ip:" + client_ip(request))
    check_rate("name:" + score.name.lower())
    if is_blocked(score.name):
        raise HTTPException(status_code=400, detail="Please pick a different name.")

    # ---- is the score believable for the time it took? ----
    run_id = None
    if score.token:
        run_id, started = read_token(score.token)
        elapsed = time.time() - started          # measured by the server, not the player
        if score.distance > max_dist_m(elapsed + GRACE_S):
            raise HTTPException(status_code=400, detail="That score doesn't match the run time.")
    elif STRICT:
        raise HTTPException(status_code=400, detail="This run could not be verified. Start a new run.")
    else:                                        # old game.js without tokens
        if score.duration_ms is None or score.distance > score.duration_ms / 1000 * LEGACY_MAX_SPEED_MPS + 30:
            raise HTTPException(status_code=400, detail="That score doesn't match the run time.")

    if STRICT and not score.secret:
        raise HTTPException(status_code=400, detail="Update the game page and try again.")

    ensure_db()
    now = int(time.time())
    name_key = score.name.lower()
    with db() as conn:
        # ---- name ownership: the first browser to post a name keeps it ----
        secret_hash = hashlib.sha256(score.secret.encode()).hexdigest() if score.secret else None
        if secret_hash:
            conn.execute(
                f"INSERT INTO players (name_key, secret_hash, created_at) VALUES ({PH}, {PH}, {PH}) "
                f"ON CONFLICT (name_key) DO NOTHING",
                (name_key, secret_hash, now),
            )
        owner = conn.execute(f"SELECT secret_hash FROM players WHERE name_key = {PH}", (name_key,)).fetchone()
        if owner and not (secret_hash and hmac.compare_digest(owner[0], secret_hash)):
            raise HTTPException(status_code=403, detail="That name belongs to another player. Please pick a different name.")

        # ---- a run token can only be used a few times, and only for rising scores ----
        if run_id:
            conn.execute(
                f"INSERT INTO runs (run_id, uses, best, created_at) VALUES ({PH}, 0, 0, {PH}) ON CONFLICT (run_id) DO NOTHING",
                (run_id, now),
            )
            claimed = conn.execute(
                f"UPDATE runs SET uses = uses + 1, best = {PH} WHERE run_id = {PH} AND uses < {PH} AND best < {PH}",
                (score.distance, run_id, MAX_POSTS_PER_RUN, score.distance),
            )
            if claimed.rowcount != 1:
                raise HTTPException(status_code=409, detail="That run was already submitted.")

        conn.execute(
            f"INSERT INTO scores (name, distance, created_at) VALUES ({PH}, {PH}, {PH})",
            (score.name, score.distance, now),
        )
        result = {
            "ok": True,
            "rank": rank_for(conn, score.distance, 0),
            "rank_week": rank_for(conn, score.distance, cutoff_for("week")),
            "rank_day": rank_for(conn, score.distance, cutoff_for("day")),
        }
    cache_clear()
    return result
