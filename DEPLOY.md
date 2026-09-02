# Deploying the API to Railway

## 1. Push this folder to GitHub

It is safe to publish now that auth exists — there are no secrets in the
code, and `.gitignore` keeps the database and `node_modules` out. Do not
commit a `.env`.

Make it a **separate repo** from the frontend. Different deploy targets,
different lifecycles.

## 2. Create the Railway service

New Project → Deploy from GitHub repo → pick the API repo. Nixpacks will
detect Node and run `npm start`.

## 3. Add a volume — do this before the first real user

`node:sqlite` writes to a file, and Railway's filesystem is **ephemeral**:
every redeploy wipes it. Without a volume, all claims, sessions and
receipt hashes vanish on each push.

    Service → Settings → Volumes → New Volume
    Mount path: /data

Then set `DB_PATH=/data/pergram.db` below. The server logs a warning at
boot if it is running in production against a relative path.

## 4. Environment variables

    NODE_ENV=production
    DB_PATH=/data/pergram.db
    THOR_NODE=https://mainnet.vechain.org
    PASSPORT_ADDR=0x35a267671d8EDD607B2056A9a13E7ba7CF53c8b3
    ALLOWED_ORIGINS=https://pergram.vercel.app

`ALLOWED_ORIGINS` is a CORS allowlist, not a wildcard — credentials
travel on these requests. Add localhost origins only while developing,
and take them out before launch.

`PORT` is injected by Railway; do not set it.

## 5. Point the frontend at it

Railway gives the service a public domain. Put it in `index.html`:

    window.PERGRAM_API = ... : 'https://your-service.up.railway.app';

Replacing `REPLACE_WITH_RAILWAY_URL`. Then redeploy the frontend on
Vercel.

## 6. Check it

    curl https://your-service.up.railway.app/api/health

Expect `{"ok":true,"round":1}`.

Then open the app and sign in. If the button does not appear, the health
check failed — nearly always CORS, so check `ALLOWED_ORIGINS` matches the
frontend's origin exactly, scheme included and no trailing slash.

## Before this is public

- **`/api/review` is unauthenticated** and exposes fraud signals. It needs
  an admin check.
- **OCR is still the `fake` adapter.** Set `OCR_PROVIDER=google` and
  `GOOGLE_VISION_KEY` when receipts go live.
- **No rate limiting.** `/api/auth/nonce` will accept as many requests as
  anyone cares to send.
- **SQLite on one instance** means one instance only. Do not scale to
  multiple replicas without moving to Postgres first.
