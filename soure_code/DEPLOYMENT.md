# Vercel frontend + Render backend

This checkpoint prepares deployment locally. It does not publish anything, create hosting services, or change GitHub. Actual hosting requires review of this checkpoint first.

## What runs where

- **Vercel:** static HTML, CSS and browser JavaScript from `dist/`. The only generated setting is the public Render backend origin.
- **Render:** FastAPI, Gemini integration, Supabase runtime connection and Upstash cache. The existing local app still works at one address.
- **Supabase:** authoritative data, role assignments, reports and simulations.
- **Upstash:** optional expiring cache. Its token stays on Render.

Both normal API requests and chat streaming connect directly from Vercel to Render. The backend accepts cross-site browser requests only from the exact `FRONTEND_ORIGINS` values configured on Render. This setting does not replace authentication or Supabase row-level security.

## 1. Render — after the checkpoint is approved and pushed

Connect the `shivangdevina/pinert` repository. For Blueprint setup, use **`soure_code/render.yaml`** as the Blueprint path. For manual Web Service setup, use:

| Setting | Value |
| --- | --- |
| Root directory | `soure_code` |
| Runtime | Python |
| Build command | `pip install -r requirements.lock.txt && pip install --no-deps .` |
| Start command | `python -m uvicorn payments_analyst.api:app --host 0.0.0.0 --port $PORT` |
| Health check | `/health` |
| Python version | `.python-version` selects the latest Python 3.12 patch |

The Blueprint selects the free plan in Singapore and turns automatic deploys off. No service is created merely by committing this file. `/health` checks the running process; it does not verify database/model readiness. Check `/datasets` separately after configuration. No migration or data import runs during a build.

Copy these existing values privately from local `.env` to Render's environment settings:

- `SUPABASE_RUNTIME_DB_URL` — restricted runtime connection, **not** the owner connection.
- `GEMINI_API_KEY`, `GEMINI_MODEL`.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

The Blueprint sets `DATA_ACCESS_MODE=public_demo`, `PLANNER_MODE=gemini`, `ENABLE_SYNTHETIC_PREVIEW=false`, `UPSTASH_CACHE_ENABLED=true`, a 120-second TTL and the separate cache namespace `payscope:render`.

Keep `FRONTEND_ORIGINS` empty until the actual Vercel URL is known. Requests made directly to Render still work; cross-site browser API access remains unavailable until step 3. Save the actual Render HTTPS service URL for Vercel. Free-service startup latency is a hosting limitation; allow the backend to finish starting before checking the frontend.

For future private customer access, also configure Supabase Auth's URL/publishable key and provision user assignments before switching `DATA_ACCESS_MODE=rbac`. The current deployment configuration is for synthetic demo data.

## 2. Vercel

Import the same repository and set:

| Setting | Value |
| --- | --- |
| Root directory | `soure_code` |
| Framework preset | Other |
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variable | `BACKEND_API_URL` = the actual Render HTTPS origin |

`vercel.json` supplies the build/output settings. Do not include `/chat`, `/api`, credentials or query parameters in `BACKEND_API_URL`. Vercel builds reject missing/non-HTTPS/localhost backend URLs. Changing this public setting requires a new frontend build.

**Do not copy `.env`, Gemini keys, database URLs or Redis tokens into Vercel.** The build uses a fixed list of public assets and generates only `assets/client-config.js`. It never copies server code or local configuration. `dist/` and private `.env` remain excluded from Git.

## 3. Connect the two deployments

Set Render's `FRONTEND_ORIGINS` to the actual Vercel origin, for example `https://YOUR-PROJECT.vercel.app`, then redeploy the backend. Multiple exact origins may be separated by commas. Preview deployments need their own explicit origin; wildcards are refused. Local development may explicitly allow an HTTP localhost origin.

Check the Vercel site loads its dataset, answers a question with streamed analysis steps, builds Next actions, and updates a simulation. Confirm a non-allowed browser origin does not receive cross-site access headers. Check the future customer/admin access paths separately when private accounts are introduced.

## Local checks

```powershell
.\.venv\Scripts\python.exe -m pytest -q
npm test
npm run check
$env:VERCEL='1'
$env:BACKEND_API_URL='https://YOUR-ACTUAL-BACKEND.onrender.com'
npm run build
```

The build-address checks validate packaging and routing, not remote hosting availability. Do not mark deployment complete until the real deployed URLs pass the browser workflow.

Official references: [Render FastAPI](https://render.com/docs/deploy-fastapi), [Render Python version](https://render.com/docs/python-version), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json).
