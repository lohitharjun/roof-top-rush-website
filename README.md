# Roof Top Rift

A one-button rooftop runner with portals, hidden worlds, coins, costumes, a global leaderboard and ad slots.

**What is in this version:** landing screen merged into the page, full-screen play, name asked once, a Scoreboard button (Today, This week, All time) plus the top 10 after every crash, costume shop (hats, scarves and the Rift Warden character), coins and revive, portals into 10 random worlds, and the car stunt, train escape, sky and city collapse challenges.

**Backend notes:** `GET /api/leaderboard?period=all|week|day` returns the best score per player (names are matched ignoring upper/lower case; "week" and "day" are the last 7 days and last 24 hours). Names are checked against a small word filter, and you can add more words with a `BLOCKED_WORDS` environment variable on Render (comma separated). Scores faster than the game's top speed are rejected. If you only change the backend, redeploy just Render; if you only change the frontend, just push to Vercel.

```
roof-top-rift/
  frontend/   static site (HTML, CSS, JS)  -> deploy on Vercel
  backend/    FastAPI leaderboard API      -> deploy on Render
```

Total size is under 100 KB, with no build step and no node_modules.

---

## 1. Test it on your laptop (VS Code)

**Backend** (open a terminal in the `backend` folder):

```
python -m venv .venv
.venv\Scripts\activate          # Windows   (Mac/Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn main:app --reload
```
Open http://localhost:8000/docs to see the API. A `scores.db` file appears on the first score.

**Frontend**: in VS Code install the *Live Server* extension, right-click `frontend/index.html`, choose **Open with Live Server**. (Alternative: run `python -m http.server 5500` inside `frontend` and open http://localhost:5500.)

`frontend/config.js` already points to `http://localhost:8000`, so the leaderboard works. The game itself still plays if the backend is off.

Controls: Space / Up / W / click / tap to jump (hold = higher), P pause, M mute. Type your name on the first screen, then press Play.

---

## 2. Deploy

Order matters a little: database, backend, frontend, then tell the backend the frontend address.

### a) Put the project on GitHub
Create a repository and push the whole `roof-top-rift` folder (the `.gitignore` is already set).

### b) Database (so scores are not lost)
Render's free web servers have a temporary disk, so a SQLite file is erased on every restart or redeploy. Use a free Postgres instead:
1. Make an account at **neon.tech**, create a project.
2. Copy the **connection string** (starts with `postgresql://`).

### c) Backend on Render
1. Render dashboard > **New > Web Service** > connect your GitHub repo.
2. Settings:
   - **Root Directory:** `backend`
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Instance type:** Free
   - **Health Check Path:** `/health`
3. **Environment** tab, add `DATABASE_URL` (the Neon string). Add `ALLOWED_ORIGINS` later in step e.
4. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`, it should show `{"status":"ok"}`.

Free Render services go to sleep after about 15 minutes without visitors, and the first request afterwards can take 30 to 60 seconds. The game shows "Waking up the leaderboard…" and wakes the server as soon as the page opens.

### d) Frontend on Vercel
1. Edit `frontend/config.js`: set `API_URL` to your Render address (no trailing slash). Commit and push.
2. Vercel > **Add New > Project** > import the repo.
3. **Root Directory:** `frontend`. **Framework Preset:** Other. Leave build and output settings empty. Deploy.

### e) Connect them
In Render > Environment, set `ALLOWED_ORIGINS` to your Vercel address, for example `https://roof-top-rift.vercel.app` (no trailing slash; if you add a custom domain, list both separated by a comma). Save, Render redeploys. Then play a run and post a score.

If the leaderboard says offline, it is almost always one of: wrong `API_URL`, `ALLOWED_ORIGINS` not matching exactly, or Render still waking up.

---

## 3. Ads (Google AdSense)

1. Get a **domain you own** (cheap ones cost a few hundred rupees a year) and add it in Vercel > Settings > Domains. AdSense is much more likely to approve a real domain than a free subdomain.
2. Apply at adsense.google.com with that domain. You need to be 18+ and have a bank account for payouts.
3. Before applying, fill in the date and email in `frontend/privacy.html`. Reviewers want a privacy policy and some real text on the page (the how-to-play and about sections count, and adding a few lines of detail helps).
4. When approved, AdSense gives you a **publisher ID** (`ca-pub-...`). Put it in `frontend/config.js` (`ADSENSE_CLIENT`), create two display ad units and paste their IDs into `ADSENSE_SLOT_1` and `ADSENSE_SLOT_2`.

Rules that protect your account: never click your own ads, never ask players to click them, and keep ads outside the game area (they already are). Earnings start small and grow with traffic.

---

## 4. Tweaking the game

Everything is at the top of `frontend/game.js`: gravity (`G`), jump strength (`JUMP`), start and top speed (`START_SPEED`, `MAX_SPEED`), how fast it speeds up (`RAMP`), portal distances (`PORTAL_FIRST`, `PORTAL_EVERY`), time spent in a world (`WORLD_LEN`) and revives per run (`REVIVE_MAX`). Costume prices are in the `HATS` and `SCARVES` lists. Revive price follows how fast you collect coins in that run (`reviveCost()`). Worlds are plain data in the `WORLDS` list, so adding one is mostly a new entry plus a background painter. Gap sizes are computed from the jump physics in `addPlatform()`, so gaps stay jumpable if you change the tuning.

## 5. Coming next
- v2.1: the 15-second car stunt challenge and 4 more worlds
- v2.2: the last 3 worlds, train escape, sky challenge, city collapse and the original unlockable character
- A daily leaderboard (add a date filter in `main.py`)
- Wrap the finished site as an Android app (Capacitor or a Trusted Web Activity) once the Play Store account is paid for
