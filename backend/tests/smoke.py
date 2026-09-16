"""Backend smoke tests — run with:  python tests/smoke.py

The suite runs against a throwaway cards file, history file and request log so it
never touches your real cards.txt or saved history.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

# Must be set before app.core.config is imported.
_TMP = Path(tempfile.mkdtemp(prefix="shopify-smoke-"))
os.environ["CARDS_FILE"] = str(_TMP / "cards.txt")
os.environ["HISTORY_FILE"] = str(_TMP / "history.json")
os.environ["LOG_FILE"] = str(_TMP / "requests.txt")
os.environ["RUNTIME_SETTINGS_FILE"] = str(_TMP / "settings.json")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition: bool, extra: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" — {extra}" if extra and not condition else ""))
    if not condition:
        FAILURES.append(name)


def main() -> int:
    print(f"Using isolated data directory: {_TMP}\n")
    with TestClient(app) as client:
        # --- health / config -------------------------------------------------
        r = client.get("/api/health")
        check("GET /api/health", r.status_code == 200 and r.json()["status"] == "ok", r.text[:200])

        r = client.get("/api/config")
        check("GET /api/config", r.status_code == 200 and "runtime_settings" in r.json(), r.text[:200])
        check(
            "job cap is 50000 tasks",
            r.json()["limits"]["max_batch_tasks"] == 50000,
            str(r.json()["limits"]["max_batch_tasks"]),
        )

        r = client.get("/api/stats")
        check("GET /api/stats", r.status_code == 200 and "stats" in r.json(), r.text[:200])

        r = client.get("/api/logs?limit=10")
        check("GET /api/logs", r.status_code == 200 and "items" in r.json(), r.text[:200])

        # --- settings --------------------------------------------------------
        r = client.put("/api/settings", json={"max_price": 42.5, "default_retries": 2})
        check("PUT /api/settings", r.status_code == 200 and r.json()["max_price"] == 42.5, r.text[:200])

        r = client.put("/api/settings", json={"site_concurrency": 99999})
        check("PUT /api/settings validation", r.status_code == 422 and r.json()["success"] is False, r.text[:200])

        r = client.post("/api/settings/reset")
        check("POST /api/settings/reset", r.status_code == 200, r.text[:200])

        # --- validation errors ------------------------------------------------
        r = client.post("/api/validate", json={"site": "not a host"})
        body = r.json()
        check("POST /api/validate invalid site", r.status_code == 422 and body["error"]["code"] == "INVALID_SITE", r.text[:200])

        r = client.post("/api/validate", json={"site": "example.com", "card": "garbage"})
        check("POST /api/validate invalid card", r.status_code == 422 and r.json()["error"]["code"] == "INVALID_CARD", r.text[:200])

        r = client.post("/api/jobs", json={"sites": []})
        check("POST /api/jobs empty sites", r.status_code == 422, r.text[:200])

        r = client.post("/api/jobs", json={"sites": ["a.b", "###"], "cards": ["bad-card"]})
        check("POST /api/jobs invalid card", r.status_code == 422 and r.json()["error"]["code"] == "INVALID_CARD", r.text[:200])

        r = client.get("/api/jobs/doesnotexist")
        check("GET /api/jobs/{id} 404", r.status_code == 404 and r.json()["error"]["code"] == "JOB_NOT_FOUND", r.text[:200])

        # --- cards ------------------------------------------------------------
        r = client.post("/api/cards", json={"lines": ["4111111111111111|12|30|123", "junk"]})
        check("POST /api/cards", r.status_code == 200 and r.json()["saved"] >= 1, r.text[:300])
        check("POST /api/cards reports invalid", r.json()["invalid_count"] == 1, r.text[:300])
        check(
            "cards file isolated from the real cards.txt",
            str(_TMP) in r.json()["snapshot"]["path"],
            r.json()["snapshot"]["path"],
        )

        r = client.get("/api/cards")
        snap = r.json()
        check("GET /api/cards masks PAN", r.status_code == 200 and "*" in snap["cards"][0]["number"], r.text[:300])

        r = client.get("/api/cards/bins")
        check("GET /api/cards/bins", r.status_code == 200 and len(r.json()["items"]) >= 1, r.text[:300])

        # --- history ----------------------------------------------------------
        r = client.get("/api/history?limit=5")
        check("GET /api/history", r.status_code == 200 and "items" in r.json(), r.text[:200])
        r = client.get("/api/history/summary")
        check("GET /api/history/summary", r.status_code == 200, r.text[:200])
        r = client.delete("/api/history")
        check("DELETE /api/history needs confirm", r.status_code == 400, r.text[:200])
        r = client.get("/api/history/export?fmt=csv")
        check("GET /api/history/export", r.status_code == 200, r.text[:200])
        r = client.get("/api/history/export?fmt=txt")
        check(
            "GET /api/history/export?fmt=txt",
            r.status_code == 200
            and r.headers["content-type"].startswith("text/plain")
            and "site" in r.text,
            r.headers.get("content-type", ""),
        )

        # --- cache ------------------------------------------------------------
        r = client.get("/api/cache")
        check("GET /api/cache", r.status_code == 200 and "items" in r.json(), r.text[:200])
        r = client.post("/api/cache/clear")
        check("POST /api/cache/clear", r.status_code == 200 and "cleared" in r.json(), r.text[:200])

        # --- products (offline: unreachable host must fail gracefully) ---------
        r = client.get("/api/products?site=this-host-does-not-exist.invalid&refresh=true")
        check(
            "GET /api/products graceful failure",
            r.status_code == 200 and r.json()["count"] == 0 and r.json()["error"],
            r.text[:300],
        )

        # --- job lifecycle with unreachable hosts -----------------------------
        r = client.post(
            "/api/jobs",
            json={
                "sites": ["this-host-does-not-exist.invalid"],
                "cards": ["4111111111111111|12|30|123"],
                "concurrency": 1,
                "retries": 1,
            },
        )
        check("POST /api/jobs created", r.status_code == 201, r.text[:300])
        job = r.json()
        job_id = job["id"]
        check("job has id + queued/running status", bool(job_id) and job["status"] in ("queued", "running"), str(job.get("status")))

        import time

        for _ in range(120):
            detail = client.get(f"/api/jobs/{job_id}").json()
            if detail["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.5)

        check("job reached terminal state", detail["status"] in ("completed", "failed", "cancelled"), detail["status"])
        check("job produced one result", len(detail["results"]) == 1, str(len(detail["results"])))
        check(
            "job result classified as error (unreachable host)",
            detail["results"][0]["bucket"] == "error",
            str(detail["results"][0]),
        )

        r = client.get(f"/api/jobs/{job_id}/results?fmt=csv")
        check("GET job results csv", r.status_code == 200 and "site" in r.text, r.text[:200])
        r = client.get(f"/api/jobs/{job_id}/results?fmt=txt")
        check(
            "GET job results txt",
            r.status_code == 200
            and r.headers["content-type"].startswith("text/plain")
            and "card_full" in r.text,
            r.headers.get("content-type", ""),
        )
        r = client.get(f"/api/jobs/{job_id}/results?fmt=json")
        check("GET job results json", r.status_code == 200 and "results" in r.text, r.text[:200])
        r = client.get(f"/api/jobs/{job_id}/live-sites")
        check("GET job live sites", r.status_code == 200, r.text[:200])
        r = client.get(f"/api/jobs/{job_id}/logs")
        check("GET job logs", r.status_code == 200 and len(r.text) > 0, r.text[:200])
        r = client.get("/api/jobs")
        check("GET /api/jobs list", r.status_code == 200 and r.json()["items"], r.text[:200])

        # SSE endpoint
        with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
            check("GET job SSE snapshot", stream.status_code == 200, str(stream.status_code))
            chunk = next(stream.iter_text())
            check("SSE carries snapshot event", "snapshot" in chunk, chunk[:200])

        # cancel of a finished job is a no-op
        r = client.post(f"/api/jobs/{job_id}/cancel")
        check("POST job cancel", r.status_code == 200, r.text[:200])

        # --- job modes --------------------------------------------------------
        r = client.post("/api/jobs", json={"sites": [], "cards": ["4111111111111111|12|30|123"], "mode": "card"})
        check("card job without a store is rejected", r.status_code == 422, r.text[:200])

        r = client.post("/api/jobs", json={"sites": ["example.com"], "cards": [], "mode": "card"})
        check("card job without cards is rejected", r.status_code == 422, r.text[:200])

        r = client.post(
            "/api/jobs",
            json={
                "sites": ["this-host-does-not-exist.invalid"],
                "cards": ["4111111111111111|12|30|123", "5424180011223344|05|27|999"],
                "mode": "card",
                "concurrency": 2,
                "retries": 1,
            },
        )
        check("card job created", r.status_code == 201, r.text[:300])
        card_job = r.json()
        check(
            "card job produces one task per card against one store",
            card_job["total"] == 2 and card_job["params"]["mode"] == "card",
            f"total={card_job['total']} mode={card_job['params']['mode']}",
        )

        # --- card mode with a random target per card ---------------------------
        from app.services.jobs import JobManager as _JM

        built = _JM.build_tasks(
            ["a.example.com", "b.example.com", "c.example.com"],
            ["4111111111111111|12|30|123"] * 7,
            "card",
            random_target=True,
        )
        targets = [t["site"] for t in built]
        # 3 stores, 7 cards: every block of 3 must be a full permutation, so no
        # store is repeated until the pool has been exhausted
        cycles = [set(targets[i: i + 3]) for i in range(0, 6, 3)]
        check(
            "random target deals one store per card without repeating early",
            len(built) == 7
            and set(targets) <= {"a.example.com", "b.example.com", "c.example.com"}
            and all(len(c) == 3 for c in cycles),
            str(targets),
        )
        check(
            "random target keeps the plain card behaviour when off",
            [t["site"] for t in _JM.build_tasks(["a.example.com"], ["x|1|1|1"], "card")] == ["a.example.com"],
        )

        # pool was seeded with live rows by the tests above? assert the failure
        # path first: an explicitly empty pool must be refused, not silently run
        r = client.post(
            "/api/jobs",
            json={"sites": [], "cards": ["4111111111111111|12|30|123"], "mode": "card", "random_target": True},
        )
        check(
            "random target with an empty pool is refused with a clear reason",
            r.status_code == 422 and "pool" in r.text.lower(),
            r.text[:300],
        )

        # seed the isolated history store so the happy path can run
        from app.api.deps import history_store as _history
        from app.services.live_sites import invalidate_cache as _invalidate

        for i in range(5):
            _history.add(
                {
                    "site": f"random-target-{i}.example.com",
                    "response": "APPROVED",
                    "bucket": "live",
                    "gate": "Shopify Payments",
                    "price": "9.99",
                },
                origin="seed",
            )
        _invalidate()

        r = client.post(
            "/api/jobs",
            json={"sites": [], "cards": ["4111111111111111|12|30|123"], "mode": "card", "random_target": True},
        )
        check("random target job created", r.status_code == 201, r.text[:300])
        if r.status_code == 201:
            rt_job = r.json()
            check(
                "random target job draws its pool from the live pool",
                rt_job["params"]["random_target"] is True
                and rt_job["params"]["sites"] == []
                and rt_job["params"]["pool_size"] == 5
                and rt_job["total"] == 1,
                str(rt_job["params"]),
            )
            check(
                "random target keeps the pool out of the job snapshot",
                isinstance(rt_job["params"]["sites"], list) and len(rt_job["params"]["sites"]) == 0,
                str(rt_job["params"].get("sites"))[:120],
            )

        r = client.post(
            "/api/jobs",
            json={"sites": ["example.com"], "cards": [], "mode": "card", "random_target": True},
        )
        check("random target still requires cards", r.status_code == 422, r.text[:200])

        # random_target is meaningless outside card mode and must be ignored
        r = client.post(
            "/api/jobs",
            json={
                "sites": ["this-host-does-not-exist.invalid"],
                "cards": ["4111111111111111|12|30|123"],
                "mode": "site",
                "random_target": True,
                "concurrency": 1,
                "retries": 1,
            },
        )
        check("random_target is ignored outside card mode", r.status_code == 201, r.text[:300])

        # site mode with no cards falls back to cards.txt (seeded by the cards
        # tests above, which wrote to the isolated temp file)
        r = client.post(
            "/api/jobs",
            json={"sites": ["this-host-does-not-exist.invalid"], "mode": "site", "concurrency": 1, "retries": 1},
        )
        check("site job without cards created (cards.txt fallback)", r.status_code == 201, r.text[:300])
        site_job = r.json()
        check(
            "site job is one task per store",
            site_job["total"] == 1 and site_job["params"]["mode"] == "site",
            f"total={site_job['total']} mode={site_job['params']['mode']}",
        )

        # and a site job must fail loudly when no card exists anywhere
        client.delete("/api/cards")
        r = client.post(
            "/api/jobs",
            json={"sites": ["this-host-does-not-exist.invalid"], "mode": "site", "concurrency": 1, "retries": 1},
        )
        if r.status_code == 201:
            empty_job = r.json()
            for _ in range(60):
                empty_detail = client.get(f"/api/jobs/{empty_job['id']}").json()
                if empty_detail["status"] in ("completed", "failed", "cancelled"):
                    break
                time.sleep(0.5)
            check(
                "site job with no cards anywhere fails with a clear reason",
                empty_detail["status"] == "failed" and "empty" in (empty_detail["error"] or ""),
                f"{empty_detail['status']} {empty_detail.get('error')}",
            )
        else:
            check("site job with no cards anywhere is rejected", r.status_code in (400, 422), r.text[:200])

        # restore a card so the site job below has a fallback
        client.post("/api/cards", json={"lines": ["4111111111111111|12|30|123"]})

        # re-create the site job now that cards.txt is populated again
        r = client.post(
            "/api/jobs",
            json={"sites": ["this-host-does-not-exist.invalid"], "mode": "site", "concurrency": 1, "retries": 1},
        )
        site_job = r.json()

        for extra in (card_job, site_job):
            for _ in range(120):
                detail_extra = client.get(f"/api/jobs/{extra['id']}").json()
                if detail_extra["status"] in ("completed", "failed", "cancelled"):
                    break
                time.sleep(0.5)
            check(
                f"{extra['params']['mode']} job finished with a result per task",
                detail_extra["status"] in ("completed", "failed", "cancelled")
                and len(detail_extra["results"]) == extra["total"],
                f"{detail_extra['status']} {len(detail_extra['results'])}/{extra['total']}",
            )

        # --- live site pool ---------------------------------------------------
        r = client.get("/api/jobs/live-sites")
        check("GET /api/jobs/live-sites", r.status_code == 200, r.text[:200])
        if r.status_code == 200:
            body = r.json()
            check(
                "live site pool is paginated and shaped correctly",
                isinstance(body.get("sites"), list)
                and isinstance(body.get("as_text"), str)
                and body.get("source") == "all"
                and "total" in body
                and "has_more" in body
                and body["limit"] == 100,
                str({k: body.get(k) for k in ("total", "limit", "has_more", "source")}),
            )
        r = client.get("/api/jobs/live-sites?limit=5000")
        check("live site pool caps the page size", r.status_code == 422, r.text[:200])
        r = client.get("/api/jobs/live-sites?source=history")
        check("live site pool filters by source", r.status_code == 200 and r.json()["source"] == "history", r.text[:200])
        r = client.get("/api/jobs/live-sites?source=bogus")
        check("live site pool rejects a bad source", r.status_code == 422, r.text[:200])
        r = client.get("/api/jobs/live-sites?fmt=text")
        check(
            "live site pool exports plain text",
            r.status_code == 200 and r.headers["content-type"].startswith("text/plain"),
            r.headers.get("content-type", ""),
        )
        check("a job id is not shadowed by /live-sites", r.headers.get("content-type", "").startswith("text/plain"))

        # seeding 1500 live rows must not slow the paged read down
        bulk = [{"site": f"seed-{i}.example.com", "response": "EXPIRED_CARD", "bucket": "live",
                 "gate": "Shopify Payments", "price": "10.00"} for i in range(1500)]
        app_history = __import__("app.api.deps", fromlist=["history_store"]).history_store
        for row in bulk:
            app_history.add(dict(row), origin="seed")
        import time as _t

        started = _t.perf_counter()
        page1 = client.get("/api/jobs/live-sites?limit=50&refresh=true").json()
        first_ms = (_t.perf_counter() - started) * 1000
        started = _t.perf_counter()
        page2 = client.get("/api/jobs/live-sites?limit=50&offset=50&search=seed-14").json()
        search_ms = (_t.perf_counter() - started) * 1000
        started = _t.perf_counter()
        _ = client.get("/api/jobs/live-sites?limit=50").json()
        cached_ms = (_t.perf_counter() - started) * 1000

        check("large pool returns only one page", len(page1["items"]) == 50 and page1["total"] >= 1500,
              f"items={len(page1['items'])} total={page1['total']}")
        check("large pool reports has_more", page1["has_more"] is True, str(page1["has_more"]))
        check("large pool search is server-side", page2["total"] < page1["total"] and page2["total"] > 0,
              f"total={page2['total']}")
        check(f"paged read stays fast ({first_ms:.0f}ms cold, {cached_ms:.0f}ms warm)",
              first_ms < 1500 and cached_ms < 500, f"cold={first_ms:.0f}ms warm={cached_ms:.0f}ms")
        check(f"search stays fast ({search_ms:.0f}ms / 1500+ rows)", search_ms < 1500, f"{search_ms:.0f}ms")

        # --- card vs store perspective ----------------------------------------
        from app.services.engine import CARD_LIVE, LIVE_RESPONSES, classify as _classify

        check(
            "site live set is the main.py LIVE_RESPONSES set",
            LIVE_RESPONSES == {
                "ORDER_PLACED", "3DS_REQUIRED", "INSUFFICIENT_FUNDS",
                "CARD_DECLINED", "INVALID_CVC", "EXPIRED_CARD",
                "INVALID_CARD", "THROTTLED",
            },
            str(sorted(LIVE_RESPONSES)),
        )
        check(
            "card live set is ORDER_PLACED + INSUFFICIENT_FUNDS",
            CARD_LIVE == {"ORDER_PLACED", "INSUFFICIENT_FUNDS"},
            str(sorted(CARD_LIVE)),
        )
        check(
            "every site live response buckets as live in a site check",
            all(_classify(code, True)["bucket"] == "live" for code in LIVE_RESPONSES),
            str({code: _classify(code, True)["bucket"] for code in sorted(LIVE_RESPONSES)}),
        )
        check(
            "only ORDER_PLACED / INSUFFICIENT_FUNDS succeed in a card check",
            [_classify(code, True, mode="card")["bucket"] for code in ("ORDER_PLACED", "INSUFFICIENT_FUNDS")]
            == ["live", "live"]
            and all(
                _classify(code, True, mode="card")["bucket"] == "die"
                for code in ("3DS_REQUIRED", "INVALID_CVC", "CARD_DECLINED", "EXPIRED_CARD", "INVALID_CARD")
            ),
            "3DS/CVC must not count as a live card",
        )
        site_view = _classify("EXPIRED_CARD", True)
        card_view = _classify("EXPIRED_CARD", True, mode="card")
        check(
            "an expired card is a LIVE store but a DECLINED card",
            site_view["bucket"] == "live" and card_view["bucket"] == "die",
            f"site={site_view['bucket']} card={card_view['bucket']}",
        )
        check(
            "a declined card still proves the store is live",
            _classify("CARD_DECLINED", False)["bucket"] == "live"
            and _classify("CARD_DECLINED", False, mode="card")["bucket"] == "die",
        )
        check(
            "the store verdict is still reported on a card scan",
            card_view["gateway_live"] is True,
            str(card_view),
        )
        check(
            "untestable results are errors in both perspectives",
            all(
                _classify(code, False, mode=mode)["bucket"] == "error"
                for code in ("CAPTCHA_REQUIRED", "TIMEOUT", "NO_PRODUCT", "GRAPHQL_ERROR")
                for mode in ("site", "card")
            ),
        )
        check(
            "throttling is live for a store check but not for a card check",
            _classify("THROTTLED", False)["bucket"] == "live"
            and _classify("THROTTLED", False, mode="card")["bucket"] == "error",
        )

        # --- card chains: an errored card moves to the next store -------------
        chained = _JM.build_tasks(
            ["primary.example.com", "fb1.example.com", "fb2.example.com"],
            ["4111111111111111|12|30|123"],
            "card",
            max_targets=3,
        )
        check(
            "card tasks carry a fallback chain",
            chained[0]["site"] == "primary.example.com"
            and sorted(chained[0]["fallbacks"]) == ["fb1.example.com", "fb2.example.com"],
            str(chained[0]),
        )
        check(
            "the chain length is capped by max_targets",
            all(
                len(t["fallbacks"]) <= 2
                for t in _JM.build_tasks(
                    [f"s{i}.example.com" for i in range(10)],
                    ["4111111111111111|12|30|123"] * 3,
                    "card",
                    random_target=True,
                    max_targets=3,
                )
            ),
        )
        check(
            "site mode keeps a single target",
            all("fallbacks" not in t for t in _JM.build_tasks(["a.example.com"], ["4111111111111111|12|30|123"], "site")),
        )

        # --- quarantining a store that keeps erroring --------------------------
        from app.api.deps import jobs as _jobs_manager
        from app.services.jobs import Job as _Job, _host_key as _hk
        from app.services.live_sites import collect_live_sites as _collect

        check("a fresh job starts with no banned sites", _Job("t", "card", {}).bad_sites == set())
        check(
            "the same host spelled differently maps to one key",
            _hk("https://bad.example.com/") == _hk("bad.example.com") == _hk("http://BAD.example.com"),
        )

        quarantined = "quarantine-me.example.com"
        _history.add(
            {
                "site": quarantined,
                "response": "EXPIRED_CARD",
                "bucket": "live",
                "mode": "site",
                "gate": "Shopify Payments",
                "price": "9.99",
            },
            origin="seed",
        )
        _history.add(
            {
                "site": quarantined,
                "response": "CAPTCHA_REQUIRED",
                "bucket": "error",
                "mode": "card",
                "gate": "N/A",
                "price": "0.00",
            },
            origin="seed",
        )
        _invalidate()
        listed = next(
            (e for e in _collect(_jobs_manager, _history, limit=1000)["items"] if e["site"] == quarantined),
            None,
        )
        check("one card error leaves the store in the pool", listed is not None, f"entry={listed}")
        check("the pool reports how often it failed", listed is not None and listed.get("errors") == 1, str(listed))

        _history.add(
            {
                "site": quarantined,
                "response": "CAPTCHA_REQUIRED",
                "bucket": "error",
                "mode": "card",
                "gate": "N/A",
                "price": "0.00",
            },
            origin="seed",
        )
        _invalidate()
        pool_sites = [e["site"] for e in _collect(_jobs_manager, _history, limit=1000)["items"]]
        check(
            "two card errors drop the store from the live pool",
            quarantined not in pool_sites,
            f"still listed: {quarantined in pool_sites}",
        )

        # a store that proves itself again comes back on its own
        _history.add(
            {
                "site": quarantined,
                "response": "EXPIRED_CARD",
                "bucket": "live",
                "mode": "site",
                "gate": "Shopify Payments",
                "price": "12.00",
            },
            origin="seed",
        )
        _invalidate()
        recovered = next(
            (e for e in _collect(_jobs_manager, _history, limit=1000)["items"] if e["site"] == quarantined),
            None,
        )
        check(
            "a store that comes back live clears its quarantine",
            recovered is not None and recovered.get("errors") == 0,
            str(recovered),
        )

        # cancelling a job must never count against the store
        _history.add(
            {
                "site": "cancel-safe.example.com",
                "response": "EXPIRED_CARD",
                "bucket": "live",
                "mode": "site",
                "gate": "Shopify Payments",
                "price": "5.00",
            },
            origin="seed",
        )
        for _ in range(2):
            _history.add(
                {
                    "site": "cancel-safe.example.com",
                    "response": "CANCELLED",
                    "bucket": "error",
                    "mode": "card",
                    "gate": "N/A",
                    "price": "0.00",
                },
                origin="seed",
            )
        _invalidate()
        cancel_entry = next(
            (
                e
                for e in _collect(_jobs_manager, _history, limit=1000)["items"]
                if e["site"] == "cancel-safe.example.com"
            ),
            None,
        )
        check(
            "a cancelled check is not a store failure",
            cancel_entry is not None and cancel_entry.get("errors") == 0,
            str(cancel_entry),
        )

        # end to end: a site that errors once is banned — no later card is sent
        # there, and the errored card itself keeps rolling to the next site
        r = client.post(
            "/api/jobs",
            json={
                "sites": ["quarantine-primary.invalid"],
                "cards": [
                    "4111111111111111|12|30|123",
                    "5424180011223344|05|27|999",
                    "4000056655665556|09|28|321",
                ],
                "mode": "card",
                "concurrency": 1,
                "retries": 1,
            },
        )
        if r.status_code == 201:
            q_job_id = r.json()["id"]
            for _ in range(240):
                q_detail = client.get(f"/api/jobs/{q_job_id}").json()
                if q_detail["status"] in ("completed", "failed", "cancelled"):
                    break
                time.sleep(0.5)
            ban_logs = [
                entry
                for entry in q_detail["logs"]
                if "banned for this job" in entry["message"] and "quarantine-primary" in entry["message"]
            ]
            check(
                "a site that errored once is banned for the rest of the job",
                len(ban_logs) == 1,
                "; ".join(e["message"] for e in ban_logs) or "no ban logged",
            )
            attempts_on_primary = sum(
                1
                for entry in q_detail["logs"]
                if "attempt 1/1" in entry["message"] and "quarantine-primary" in entry["message"]
            )
            check(
                "no other card is ever sent to the banned site",
                attempts_on_primary == 1,
                f"attempts on primary={attempts_on_primary}",
            )
            skip_logs = [
                entry
                for entry in q_detail["logs"]
                if "skipping" in entry["message"] and "quarantine-primary" in entry["message"]
            ]
            check(
                "later cards skip the banned site",
                len(skip_logs) == 2,
                f"{len(skip_logs)} skip log(s): {'; '.join(e['message'] for e in skip_logs[:3])}",
            )
            no_target_rows = [
                row
                for row in q_detail.get("results", [])
                if str(row.get("response", "")).startswith("NO_TARGET_AVAILABLE")
            ]
            check(
                "cards roll to the next site instead of NO_TARGET_AVAILABLE",
                len(no_target_rows) == 0,
                f"{len(no_target_rows)} NO_TARGET_AVAILABLE row(s): {[r.get('card') for r in no_target_rows[:3]]}",
            )
            # the quarantined store is gone from the pool while the job runs
            _invalidate()
            pool_after_job = [e["site"] for e in _collect(_jobs_manager, _history, limit=1000)["items"]]
            check(
                "the pool drops the failing store after two card errors",
                not any("quarantine-primary" in s for s in pool_after_job),
                str([s for s in pool_after_job if "quarantine-primary" in s]),
            )
        else:
            check("quarantine job created", r.status_code == 201, r.text[:200])


        # end to end: a card on an unreachable store must walk the whole chain and
        # end up erroring only after every store was tried
        r = client.post(
            "/api/jobs",
            json={
                "sites": ["chain-primary.invalid"],
                "cards": ["4111111111111111|12|30|123"],
                "mode": "card",
                "concurrency": 1,
                "retries": 1,
            },
        )
        if r.status_code == 201:
            chain_job = r.json()
            chain_id = chain_job["id"]
            for _ in range(120):
                chain_detail = client.get(f"/api/jobs/{chain_id}").json()
                if chain_detail["status"] in ("completed", "failed", "cancelled"):
                    break
                time.sleep(0.5)
            first = (chain_detail.get("results") or [{}])[0]
            used_host = (first.get("site") or "").replace("https://", "").replace("http://", "").rstrip("/")
            check(
                "an errored card is rechecked on further stores before giving up",
                (first.get("targets_tried") or 0) > 1,
                f"targets_tried={first.get('targets_tried')} site={first.get('site')}",
            )
            check(
                "the record keeps the store that was actually used",
                "chain-primary.invalid" in (first.get("requested_site") or "")
                and used_host != "chain-primary.invalid",
                f"requested={first.get('requested_site')} used={first.get('site')}",
            )
        else:
            check("chain job created", r.status_code == 201, r.text[:200])

        # --- docs -------------------------------------------------------------
        r = client.get("/openapi.json")
        check("GET /openapi.json", r.status_code == 200 and "/api/jobs" in r.text, r.text[:120])

    print("\n" + ("=" * 60))
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED: {', '.join(FAILURES)}")
        return 1
    print("All smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
