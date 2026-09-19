# Shopify Checkout Validator — Web Edition

Modern web application built on top of the original `main.py` FastAPI service. The Python engine
(Shopify checkout flow: cart → checkout session → shipping/delivery negotiation → card
tokenization → submit → receipt polling) is preserved as the single source of truth and is now
exposed through a documented HTTP API and a full Next.js dashboard.

```
Browser (Next.js dashboard)
        ↓  /api/*  (proxy rewrites)
FastAPI backend  (backend/app)
        ↓
ShopifyEngine  ←  verbatim port of main.py
        ↓
curl_cffi sessions → Shopify stores / PCI vault
```

---

## 1. What was migrated from `main.py`

| Original (`main.py`)                                      | Now                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /shopify?site&cc&proxy&max_price`                     | `POST /api/validate` — full checkout submission                     |
| `GET /check?site&card&proxy&max_price`                     | `POST /api/check` — gateway probe with `valid` verdict              |
| `GET /health`                                              | `GET /api/health` (plus job counters, cache size, uptime)           |
| `GET /stats`                                               | `GET /api/stats` (+ history aggregation)                            |
| `POST /cache/clear`                                        | `POST /api/cache/clear` and `GET /api/cache` (inspectable)          |
| `POST /reload`                                             | `POST /api/cards/reload`                                            |
| `cards.txt` edited by hand                                 | `/cards` UI: paste, import `.txt`, append/replace, empty, BIN stats |
| Embedded HTML dashboard (vanilla JS)                       | Next.js 15 + React 19 + Tailwind + shadcn-style UI                  |
| Client-side loop calling `/check` once per store           | Server-side **jobs** with progress, SSE streaming, pause/cancel     |
| `LIVE_RESPONSES` classification                            | Same set, plus a reconciled `live` / `die` / `error` bucket         |
| `requests.txt` traffic log                                 | `/logs` page (application ring buffer **and** `requests.txt` tail)  |
| — (new)                                                    | Product discovery UI (`/stores`) with the sitemap fallback          |
| — (new)                                                    | Persistent execution history with filters + TXT/JSON export         |
| — (new)                                                    | Runtime settings (price cap, concurrency, timeouts, cache, logging) |

Everything the Python code did is still done by Python. Nothing was reimplemented in JavaScript
except presentation logic.

### Engine functions kept 1:1
`LoggedSession`, the GraphQL documents (`QUERY_PROPOSAL_SHIPPING`, `QUERY_PROPOSAL_DELIVERY`,
`MUTATION_SUBMIT`, `QUERY_POLL`), `_fetch_products`, `validate_card`, `_parse_card`,
`_parse_proxy`, `_pick_address`, `_random_identity`, `_extract`, `_extract_sst`,
`_normalize_response`, `_parse_gql_errors` and the `C2C` / `ADDRESS_BOOK` / identity tables.

---

## 2. Requirements

* **Python 3.11+** (developed on 3.13)
* **Node.js 20+** (developed on 24)
* Windows, macOS or Linux. No database, no Redis, no Docker.

---

## 3. Installation (Windows / PowerShell)

### One click

```bat
install.bat      :: creates the virtualenv, installs Python + Node packages,
                 :: and builds the dashboard - nothing else to do
```

Needs only Python 3 and Node.js on `PATH`. When it finishes, start the app with `start.bat`.

### Manual

```powershell
# --- backend ---
cd c:\xampp\htdocs\shopify
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt

# --- frontend ---
cd frontend
npm install
npm run build
```

Optional configuration:

```powershell
Copy-Item .env.example .env      # from the project root
```

---

## 4. Running

### Both servers at once

```bat
start.bat        :: one click - production build, backend in its own window
start.bat dev    :: dev mode (Turbopack) for when you are editing the frontend
```

Starts FastAPI on <http://127.0.0.1:8080> and the dashboard on <http://localhost:3000>.
The batch file builds the frontend on first run (one-time), checks the virtualenv, and keeps
the backend in a separate minimised window.
PowerShell alternative:

```powershell
.\dev.ps1        # production build — fast page loads (recommended)
.\dev.ps1 -Dev   # next dev with Turbopack, for when you are editing the frontend
```

> **Why not `next dev` by default?** Dev mode recompiles every route on first
> visit, which made page loads take seconds to minutes (the `/jobs` route took
> ~2 minutes to compile). The production build serves pre-compiled pages in
> milliseconds. Only use `-Dev` while actively changing frontend code.

### Backend only

```powershell
cd backend
..\.venv\Scripts\python.exe run.py          # reload enabled
..\.venv\Scripts\python.exe run.py          # or: uvicorn app.main:app --reload --port 8080
```

* API docs: <http://127.0.0.1:8080/docs>
* OpenAPI: <http://127.0.0.1:8080/openapi.json>

### Frontend only

```powershell
cd frontend
npm run build      # production build (pre-compiles every route)
npm start          # serve the production build — http://localhost:3000
npm run dev        # dev mode (Turbopack), only while editing the frontend
```

If the API runs on another host, point the frontend at it:

```powershell
$env:BACKEND_URL = "http://192.168.1.20:8080"
npm run build
npm start
```

---

## 5. Configuration

`.env` at the project root (all optional, defaults match `main.py`):

| Variable                  | Default                       | Meaning                                     |
| ------------------------- | ----------------------------- | ------------------------------------------- |
| `HOST` / `PORT`            | `127.0.0.1` / `8080`          | Backend bind address                        |
| `CARDS_FILE`               | `cards.txt`                   | Cards file (one `cc\|mm\|yy\|cvv` per line)  |
| `MAX_PRICE`                | `500`                         | Cart ceiling (product + shipping + tax)     |
| `SITE_CONCURRENCY`         | `15`                          | Simultaneous requests per store             |
| `POOL_SIZE` / `POOL_PER_HOST` | `500` / `25`               | curl_cffi connection pool                   |
| `CONNECT_TIMEOUT` / `REQUEST_TIMEOUT` | `8` / `35`          | Timeouts in seconds                         |
| `CACHE_TTL`                | `300`                         | Product cache lifetime (seconds)            |
| `DEFAULT_CONCURRENCY`      | `3`                           | Default batch workers                       |
| `DEFAULT_RETRIES`          | `1`                           | Default attempts per task                   |
| `MAX_BATCH_TASKS`          | `50000`                       | Sites (or cards) allowed per job            |
| `HISTORY_LIMIT`            | `5000`                        | History entries retained                    |
| `HISTORY_STORE_FULL_CARDS` | `false`                       | Persist full PANs in history (off by default) |
| `LOG_LEVEL`                | `info`                        | `debug` \| `info` \| `warning` \| `error`    |
| `CORS_ORIGINS`             | `*`                           | Comma separated list of allowed origins     |

`MAX_PRICE`, `SITE_CONCURRENCY`, `REQUEST_TIMEOUT`, `CONNECT_TIMEOUT`, `CACHE_TTL`,
`DEFAULT_CONCURRENCY`, `DEFAULT_RETRIES`, `LOG_LEVEL`, `HISTORY_LIMIT` and
`HISTORY_STORE_FULL_CARDS` can also be changed at runtime from **Settings** (persisted to
`backend/data/settings.json`).

### Files created at runtime

```
backend/data/requests.txt   full outgoing HTTP trace (contains card data — keep private)
backend/data/history.json   execution history
backend/data/settings.json  runtime settings overrides
cards.txt                    cards used when a request omits the card
```

---

## 6. API reference

All endpoints are documented in the OpenAPI schema. Errors are always:

```json
{ "success": false, "error": { "code": "INVALID_CARD", "message": "…", "details": null } }
```

| Method | Path                        | Description                                             |
| ------ | --------------------------- | ------------------------------------------------------- |
| GET    | `/api/health`               | Status, card count, job counters, cache size, uptime    |
| GET    | `/api/config`               | Runtime settings, limits, response vocabulary           |
| GET    | `/api/stats`                | Engine counters + history aggregation                   |
| GET    | `/api/logs`                 | Recent application log records (ring buffer)            |
| GET    | `/api/requests-log`         | Tail of `requests.txt`                                  |
| POST   | `/api/validate`             | Full checkout validation for one store                  |
| POST   | `/api/check`                | Gateway probe for one store                             |
| GET    | `/api/products`             | Cheapest in-stock variants under the price cap          |
| POST   | `/api/jobs`                 | Create a batch job (`mode`: `site` \| `card` \| `pair`, default `pair`; `random_target` deals each card its own store from `sites` — or from the live pool when `sites` is empty) |
| GET    | `/api/jobs/live-sites`      | **Pooled live stores** across all site jobs + history (`source`, `include_running`, `offset`, `limit`, `search`, `refresh`, `fmt=text`) |
| GET    | `/api/jobs`                 | List jobs                                               |
| GET    | `/api/jobs/{id}`            | Job status, results and logs                            |
| GET    | `/api/jobs/{id}/events`     | **SSE** stream: `snapshot`, `status`, `log`, `task_start`, `task_done`, `progress` |
| POST   | `/api/jobs/{id}/pause`      | Pause between tasks                                     |
| POST   | `/api/jobs/{id}/resume`     | Resume a paused job                                     |
| POST   | `/api/jobs/{id}/cancel`     | Cooperative cancellation                                |
| DELETE | `/api/jobs/{id}`            | Cancel and forget a job                                 |
| GET    | `/api/jobs/{id}/results`    | Results as JSON, TXT or CSV (`?fmt=txt&bucket=live`)         |
| GET    | `/api/jobs/{id}/live-sites` | Unique live sites (plain text)                          |
| GET    | `/api/jobs/{id}/logs`       | Job log as plain text                                   |
| GET    | `/api/cards`                | Cards snapshot (PANs masked, CVVs hidden)               |
| POST   | `/api/cards`                | Replace the cards file                                  |
| POST   | `/api/cards/append`         | Append cards                                            |
| POST   | `/api/cards/upload`         | Upload a `.txt` file (multipart, ≤ 4 MB)                |
| POST   | `/api/cards/reload`         | Reload from disk                                        |
| DELETE | `/api/cards`                | Empty the cards file                                    |
| GET    | `/api/cards/bins`           | BIN distribution                                        |
| GET    | `/api/history`              | Paginated history (`site`, `bucket`, `response`, `search`) |
| GET    | `/api/history/summary`      | Aggregated counters                                     |
| GET    | `/api/history/export`       | Download history as JSON/TXT (CSV kept for compatibility)                            |
| DELETE | `/api/history?confirm=true` | Clear history                                           |
| GET    | `/api/settings`             | Current runtime settings                                |
| PUT    | `/api/settings`             | Update runtime settings                                 |
| POST   | `/api/settings/reset`       | Restore `.env` defaults                                 |
| GET    | `/api/cache`                | Inspect the product cache                               |
| POST   | `/api/cache/clear`          | Clear the product cache                                 |

### Response classification

`bucket` combines the original `LIVE_RESPONSES` set with the client-side tabs of the old UI, and
**the live set depends on what is being checked** — a site scan judges the store, a card scan judges
the card. The same response can therefore land in different buckets:

| Response | Site check (`mode: site`) | Card check (`mode: card`) |
| --- | --- | --- |
| `ORDER_PLACED` | **live** | **live** (charged) |
| `INSUFFICIENT_FUNDS` | **live** | **live** (card valid, no funds) |
| `3DS_REQUIRED` | **live** | declined |
| `INVALID_CVC` | **live** | declined |
| `CARD_DECLINED` | **live** | declined |
| `EXPIRED_CARD` | **live** | declined |
| `INVALID_CARD` | **live** | declined |
| `THROTTLED` | **live** | error |
| `CAPTCHA_REQUIRED`, `TIMEOUT`, `NO_PRODUCT`, `GRAPHQL_ERROR`, … | error | error |

* **Site check live set** — `LIVE_RESPONSES`, byte-identical to `main.py`: `ORDER_PLACED`,
  `3DS_REQUIRED`, `INSUFFICIENT_FUNDS`, `CARD_DECLINED`, `INVALID_CVC`, `EXPIRED_CARD`,
  `INVALID_CARD`, `THROTTLED`. This is exactly what the original `/check` reported as `valid`.
* **Card check live set** — `CARD_LIVE`: `ORDER_PLACED`, `INSUFFICIENT_FUNDS` only. Every other
  response the gateway processes is a decline from the card's point of view.

Anything in `ERROR_RESPONSES` that is not a live answer means the check could not be completed;
anything else is a decline. A response carrying detail after a colon (`NO_PRODUCT: No products
found`) is bucketed by its base code.

The raw bucket keys stay `live` / `die` / `error` for API compatibility; only the wording changes
in the UI (Live/Die vs Success/Declined). `gateway_live` always describes the *store* — the raw
`LIVE_RESPONSES` membership — so a card scan still records whether the store processed the card.

Error bucket: `THROTTLED`, `TIMEOUT`, `GRAPHQL_ERROR`,
`CART_FAILED`, `NO_ATTEMPT_TOKEN`, `NO_SESSION_TOKEN`, `SESSION_EXPIRED`,
`NO_SHOPIFY_PAYMENTS_GATEWAY`, `NO_PRODUCT`, `SITE_REQUIRES_LOGIN`, `CHECKPOINTDENIED`,
`NEGOTIATE_FAILED`, `NO_SELLER_PROPOSAL`, `TOKENIZATION_FAILED`, `SUBMIT_FAILED`,
`PRICE_OVER_MAX`, `CAPTCHA_REQUIRED`, `CHECKOUT_FAILED`, `CANCELLED`, `ERROR`, `NETWORK_ERROR`.

---

## 7. Dashboard pages

| Page            | Purpose                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `/`             | Dashboard: KPIs, recent jobs, response distribution, single-store validation  |
| `/site-validator` | **Site validator** — many stores, one task each. Finds stores with a live gateway |
| `/card-validator` | **Card validator** — many cards against one store, or one random store per card (live pool or your own list) |
| `/jobs`         | All jobs with live progress bars                                              |
| `/stores`       | Product discovery, variant IDs, jump straight into validation                 |
| `/cards`        | `cards.txt` manager with BIN statistics                                       |
| `/history`      | Filterable execution history with TXT/JSON export                             |
| `/logs`         | Application log ring buffer + `requests.txt` trace                            |
| `/settings`     | Runtime settings, response vocabulary, product cache, danger zone             |

### Job modes

Every job carries a `mode` that decides how the task list is built:

| Mode   | Task list                                            | Card source                         |
| ------ | ---------------------------------------------------- | ----------------------------------- |
| `site` | One task per store                                    | The single supplied card, or `cards.txt` (one entry per store, cycling) |
| `card` | One task per card, all against `sites[0]`             | Each task carries its own card      |
| `card` + `random_target` | One task per card, each on its own store — the pool is the supplied `sites`, or the live-site pool when none are sent | Each task carries its own card |
| `pair` | Index-paired: `tasks[i] = (sites[i % n], cards[i % m])` | Index-paired lists                  |

The Site validator always sends `mode: "site"` and the Card validator `mode: "card"`. `pair` and
`site` stay supported by the API for backwards compatibility (and `mode` defaults to `pair` for
clients that predate the validators), but the dashboard only drives the two validator pages. Jobs
opened from the jobs list land on whichever validator matches their mode.

### Random targeting (card mode)

The card validator has a **“Random live site per card”** switch. With it on, the job is created with
`random_target: true` and every card is dealt its own store:

* **`Live pool` (default)** — `sites` is left empty, so the backend reads the whole live-site pool
  (the per-mode store requirement is deliberately skipped) and **shuffles it once**;
* **`Custom list`** — the stores you paste or load (`SiteListField`, with *Clean URLs*, drag-and-drop
  and *Load stores from file*) become the pool instead of the live site pool; they are normalised and
  de-duplicated exactly like any other site list and mixed in the same way;
* the raw pool is kept out of the job snapshot (`sites: []`, plus `pool_size` / `sites_count` / the
  `pool_source` tag) so polling and SSE never ship thousands of URLs to the browser;
* card *i* is then dealt `shuffled[i % pool_size]`, so every card gets a random store but no store
  repeats until the pool has been used up — one run sweeps many gateways instead of hammering one;
* `422 NO_LIVE_SITES` comes back if there is no pool at all — neither a custom list nor a populated
  live pool — rather than silently running against nothing.

`random_target` is ignored for any mode other than `card`.

### Card scans: error rollover

A card check only ends when the card earns a **real verdict** — success or decline. When a card errors
out (`CAPTCHA_REQUIRED`, `THROTTLED`, `TIMEOUT`, `NO_PRODUCT`, …) the same card is **rechecked on the
next store** and keeps moving until it lands a verdict or runs out of stores:

* the primary target is the one you picked (or the card's slot in the shuffled pool — live or custom
  — for random targeting); the rest of that pool becomes its fallback chain;
* the chain is capped by `CARD_MAX_TARGETS` (default 12) so one impossible card cannot sweep the
  whole pool;
* `retries` still applies *per store* — the chain only advances once a store's attempts are spent;
* the job log shows each hop (`CAPTCHA_REQUIRED on store-a, rechecking on store-b (2/12)`), the
  result row keeps the store that finally produced the verdict, and `targets_tried` records how many
  stores were visited (also exported in the TXT/CSV/JSON results);
* the UI marks such rows with `×N stores`.

**A store that errors is banned for the rest of the job** — but only when the *store* is at fault.
`CAPTCHA_REQUIRED`, `THROTTLED`, `TIMEOUT`, `NO_PRODUCT`, `NO_SHOPIFY_PAYMENTS_GATEWAY`,
`SESSION_EXPIRED`, `CHECKPOINTDENIED`, `GRAPHQL_ERROR` and friends make the host a *bad site*: the
errored card rolls to the next store, and every later card skips it
(`skipping store-x — banned after an earlier card error`). Card-level failures
(`TOKENIZATION_FAILED`, `SUBMIT_FAILED`) say nothing about the store, so they no longer ban it —
one rate-limited card used to take the whole target out of the run. A card with no usable store
left is reported as `NO_TARGET_AVAILABLE`. Separately, a store that collects `CARD_ERROR_LIMIT`
(default 2) card errors *across jobs* — in the running job or in history — is dropped from the live
pool entirely. That count is "errors since the store last proved itself": any later live row or real
card verdict resets it, so a store that recovers returns to the pool on its own.
Cancelling a job is *your* call, not the store's: `CANCELLED` rows never ban a site in the running
job and never count toward the pool quarantine.

### Card tokenization (PCI vault)

Tokenizing the card is the one step that happens off the store
(`checkout.pci.shopifyinc.com/sessions`), and it is the step Shopify rate-limits. Burst several cards
at one store — which is exactly what a card scan does — and the vault answers **429 Too Many
Requests** even though the store itself is perfectly healthy.

* a throttled tokenization is **retried** (`VAULT_ATTEMPTS`, default 3), honouring `Retry-After` when
the vault sends one and otherwise backing off ~1s → 2s with jitter, before giving up;
* only then is `deposit.shopifyinc.com/sessions` tried once as a backup host;
* if it still fails, the row carries the reason instead of a bare code —
`TOKENIZATION_FAILED: HTTP 429 Too Many Requests`, with the full text in the `detail` column and in
the TXT/CSV/JSON exports — so a vault throttle is never mistaken for a dead card;
* the store is **not** banned for it (see the rule above), so the remaining cards still target the
store you chose instead of spilling onto random pool sites.

Practical note: `site_concurrency` (Settings, default 15) caps how many parallel flows one host may
run. A card scan aims every worker at one store, so lowering `workers` is the quickest way to stay
under the vault's limit.

### Live site pool

The card validator does not ask you to type a store. It reads the **live site pool** from
`GET /api/jobs/live-sites` and you pick a target from the list — or let random targeting deal one
out per card, either from that pool or from a custom list you paste in. The pool merges two sources
so it survives restarts:

1. the results of every job this process still holds (`mode: site`, bucket `live`), and
2. the persisted history file — which covers earlier sessions.

Each entry carries the gateway, the responses it produced (`EXPIRED_CARD`, `3DS_REQUIRED`, …),
when it was last seen, and the product/price used. The picker supports search, source filtering
(`all` / `jobs` / `history`), a random pick, and copy-all. `?fmt=text` returns a plain-text list for
piping elsewhere.

The pool is built for large collections — search, filtering and paging all happen server-side
(`offset` / `limit`, 1000 max per page) behind a 5s memo, and the list is virtualised so only the
visible rows are in the DOM. A pool of thousands of stores behaves like a pool of twenty.

UX details: dark/light/system theme, responsive layouts (sidebar becomes a drawer under `lg`),
skeleton loaders, empty/error states with retry, confirmation dialogs for destructive actions,
copy-to-clipboard everywhere, debounced/instant search filters, drag-and-drop **or
click-to-pick** `.txt` import for stores and cards on both validators (site validator and
card validator — the file picker and the drop zone share the same cleaner, so both
report how many usable lines were loaded), last-job restore after a refresh, and
`prefers-reduced-motion` support.

---

## 8. Testing

### Backend smoke tests (98 checks)

```powershell
cd backend
..\.venv\Scripts\python.exe tests\smoke.py
```

The suite writes to a throwaway temp directory (`CARDS_FILE`, `HISTORY_FILE`, `LOG_FILE`,
`RUNTIME_SETTINGS_FILE` are overridden before the app is imported), so your real `cards.txt`,
history and request log are never touched.

Covers health/config/stats/logs, settings validation and reset, invalid input handling for every
route, cards read/write/mask/BINs, history filters + export + confirmation guard, cache control,
graceful failure of product discovery, all three job modes (including the per-mode rejection rules
and the `cards.txt` fallback for site jobs), a full job lifecycle (create → poll → terminal state →
results → TXT/JSON → live sites → logs → SSE snapshot → cancel) and the OpenAPI schema.

### Manual end-to-end

```powershell
# product discovery against a real store
curl.exe "http://127.0.0.1:8080/api/products?site=allbirds.com&max_price=60"

# single validation
curl.exe -X POST "http://127.0.0.1:8080/api/validate" -H "Content-Type: application/json" `
  -d '{\"site\":\"allbirds.com\",\"card\":\"4111111111111111|12|30|123\",\"max_price\":60}'

# batch job
curl.exe -X POST "http://127.0.0.1:8080/api/jobs" -H "Content-Type: application/json" `
  -d '{\"sites\":[\"allbirds.com\",\"kith.com\"],\"cards\":[\"4111111111111111|12|30|123\"],\"concurrency\":2}'
```

### Type checking

```powershell
cd frontend
npm run typecheck
npm run build
```

---

## 9. Deploying to Vercel

Deployed as **one project with two services** (Vercel Services): the Next.js
frontend and the FastAPI backend share the production domain
<https://shopify-checkout-validator.vercel.app> — the dashboard at `/`, the API
under `/api/*` and `/docs`.

The root `vercel.json` defines both services and the routing:

```json
{
  "services": {
    "frontend": { "root": "frontend", "framework": "nextjs" },
    "backend":  { "root": "backend", "entrypoint": "app.main:app" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/docs", "destination": { "service": "backend" } },
    { "source": "/redoc", "destination": { "service": "backend" } },
    { "source": "/openapi.json", "destination": { "service": "backend" } },
    { "source": "/(.*)", "destination": { "service": "frontend" } }
  ]
}
```

Notes:

* On Vercel (`VERCEL=1`) the backend auto-routes runtime data to `/tmp` —
  history, settings, request log and the cards file — so the read-only
  filesystem is never touched. No environment variables are required.
* Every push to `main` deploys automatically; `vercel deploy --prod` deploys
  from the CLI.
* `middleware.ts` was replaced by `next.config.ts` `headers()` because Edge
  middleware is not supported in multi-service projects.
* Deployment Protection is **off** — the whole site is public. Re-enable
  "Require Log In" in Project Settings → Deployment Protection if you want it
  gated (the dashboard then works only when you are logged in to Vercel).

### Serverless caveats

* **Batch jobs are unreliable**: workers run as asyncio background tasks inside
  a function invocation; the instance freezes or dies when requests stop
  (max ~60s on Hobby). Single `/api/check` calls fit in the window, multi-card
  jobs usually don't. Job state is in-memory, so a cold start loses running jobs.
* **`/tmp` is ephemeral**: history, settings and uploaded cards reset on cold
  starts.
* **No auth**: everything is public. Add your own protection before pointing a
  domain at it.

---

## 10. Security notes

* Input validation happens on the client **and** on the server (site normalization rejects
  anything that is not a real hostname; cards, proxies, price caps and job sizes are validated
  with Pydantic).
* No shell commands are constructed from user input; the engine only performs HTTP requests.
* File uploads are size-limited (4 MB) and parsed line by line — no path traversal surface.
* Backend errors are returned as structured JSON; stack traces never reach the browser.
* Card PANs are masked in history by default; job results carry the full `cc|mm|yy|cvv`
  (`card_full`) so every tested card can be identified — keep job exports local.
* Passwords, tokens and proxy credentials are never written to application logs.
* Secrets stay server-side — the frontend receives only non-sensitive configuration.
* `requests.txt` contains the card payloads sent to the PCI vault. Treat it as sensitive data and
  delete it when you no longer need the trace.
* Keep the backend bound to `127.0.0.1`. If you expose it, set `CORS_ORIGINS` to your dashboard
  origin and put it behind authentication.

---

## 11. Project structure

```
shopify/
├── main.py                     original service (kept as the source of truth)
├── cards.txt                   cards used when a request omits one
├── .env.example                configuration template
├── install.bat                 one-click installer (venv + packages + build)
├── start.bat                   one-click launcher (backend + dashboard)
├── dev.ps1                     PowerShell launcher (same, with -Dev switch)
├── backend/
│   ├── requirements.txt
│   ├── run.py                  launcher
│   ├── vercel.json             serverless rewrites + function limits
│   ├── tests/smoke.py          smoke test suite
│   ├── data/                   requests.txt · history.json · settings.json
│   ├── api/index.py            Vercel serverless entrypoint
│   └── app/
│       ├── main.py             FastAPI app factory
│       ├── api/
│       │   ├── deps.py         service singletons + input validation helpers
│       │   └── routes/         system · validate · jobs · cards · history · settings
│       ├── core/               config · logging · errors · middleware
│       ├── models/schemas.py   Pydantic request/response models
│       └── services/
│           ├── engine.py       ported Shopify engine (GraphQL + checkout flow)
│           ├── jobs.py         job runner, SSE events, cancellation
│           ├── cards.py        cards file handling
│           ├── history.py      JSON history store
│           └── live_sites.py   aggregated live-site pool (paginated, memoised)
└── frontend/
    ├── app/                    dashboard · site/card validators · jobs · stores · cards · history · logs · settings
    ├── components/
    │   ├── ui/                 shadcn-style primitives
    │   ├── layout/             app shell, sidebar, topbar, theme, status
│   │   ├── batch/              site/card validators, job monitor, log panel,
│   │   │                       run settings, input panels, stat tiles
│   │   └── validate/           single-store form + result panel
│   ├── hooks/                  use-job-stream (SSE) · use-job-launcher (submission)
    ├── lib/                    api client, utils, toasts
    └── types/api.ts            shared API types
```

---

## 12. Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Pages take seconds to load | You are running `next dev` — every route compiles on demand. Use the production build (`npm run build` + `npm start`, or `./dev.ps1`). |
| “Cannot reach the API server” toast | Start the backend (`python run.py`) on port 8080, or set `BACKEND_URL` before `npm run dev`. |
| Import error `No module named 'app'` | Run from `backend/` or use `uvicorn app.main:app --app-dir backend`. |
| `curl_cffi` install fails | Upgrade pip (`python -m pip install -U pip`) — wheels are required for Python 3.13. |
| Everything returns `THROTTLED` | Lower `SITE_CONCURRENCY` / job workers; the store is rate limiting you. |
| Results are all `NO_PRODUCT` | Raise the price cap or pin a variant — the store has nothing in stock under the cap. |
| `NO_SHOPIFY_PAYMENTS_GATEWAY` | The store does not expose Shopify Payments (only that gateway can be tested). |
| Job sits at “queued” | The worker loop is busy on earlier tasks; check `/logs` for transport errors. |
| SSE shows “polling” | A proxy is buffering the stream; the UI fell back to polling automatically. |
| Empty `requests.txt` | Nothing has been sent yet — run a check. |

---

## 13. Known limitations

1. **`/check` vs `/validate`.** In the original code both routes called the same `validate_card()`
   and differed only in the response envelope. That behaviour is preserved: the probe mode returns
   the `/check` shape, the full mode the raw engine result.
2. **Retries.** The original UI had a retry selector that was never used by the JS. The retry count
   is now honoured for real (only `error`-bucket results are retried), so a job can take longer
   than the old one-shot loop.
3. **Cancellation** is cooperative: it lands between engine steps, so an in-flight HTTP request
   finishes first.
4. **Pause** stops the worker pool between tasks; the currently running task completes.
5. **`main.py` is not deleted.** It remains the reference implementation. The web app runs
   `backend/app`, which is the ported engine — the two are not wired together automatically.
6. **No authentication.** This is a local operator tool; do not expose it to the internet without
   adding auth and locking down `CORS_ORIGINS`.
7. **Product cache is per-process** and keyed by `host|price-cap`. Running uvicorn with
   `--workers > 1` gives each worker its own cache and job registry, so keep a single worker (the
   default) for consistent UI state. Raising the cap mid-session re-fetches the catalog instead of
   reusing a narrower cached list.
