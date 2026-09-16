"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { CreditCard, Shuffle } from "lucide-react";

import { api } from "@/lib/api";
import { splitLines } from "@/lib/utils";

import { RunSettingsFields, DEFAULT_RUN_SETTINGS, type RunSettings } from "@/components/batch/run-settings";
import { CardInput } from "@/components/batch/card-input";
import { LiveSitesPicker } from "@/components/batch/live-sites-picker";
import { JobRunner } from "@/components/batch/job-runner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useJobStream } from "@/hooks/use-job-stream";
import { useJobLauncher } from "@/hooks/use-job-launcher";

const STORAGE_KEY = "shopify-validator:card-validator";

/**
 * Test a card list against a store — either one fixed store, or (random mode)
 * a different live store for every card.
 */
export function CardValidator({ initialJobId = null }: { initialJobId?: string | null }) {
  const [site, setSite] = useState("");
  const [cards, setCards] = useState("");
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_RUN_SETTINGS);
  const [randomTarget, setRandomTarget] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId);

  // A job id can also arrive through the URL (deep link from /jobs, back button).
  // Adopt it, but never remount on it — that would wipe the job id we just set
  // ourselves plus everything the user typed.
  const urlJobRef = useRef<string | null>(initialJobId);
  useEffect(() => {
    const next = initialJobId ?? null;
    if (next === urlJobRef.current) return;
    urlJobRef.current = next;
    if (next) setJobId(next);
  }, [initialJobId]);

  const { data: settingsData } = useSWR("settings", api.settings);
  const { data: health } = useSWR("health", api.health, { refreshInterval: 15000 });
  // only the pool size is needed here, so ask for the smallest possible page
  const { data: pool } = useSWR(["card-validator", "pool-size"], () => api.liveSitesPool({ limit: 1 }), {
    refreshInterval: 30000,
  });
  const stream = useJobStream(jobId, { resumeLast: STORAGE_KEY, onResume: setJobId });
  const { start, starting, forget } = useJobLauncher(setJobId);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY + ":inputs") ?? "null");
      if (saved) {
        setSite(saved.site ?? "");
        setCards(saved.cards ?? "");
        setRandomTarget(Boolean(saved.randomTarget));
        setSettings((prev) => ({ ...prev, ...(saved.settings ?? {}) }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const payload = JSON.stringify({ site, cards, settings, randomTarget });
    const timer = setTimeout(() => window.localStorage.setItem(STORAGE_KEY + ":inputs", payload), 400);
    return () => clearTimeout(timer);
  }, [site, cards, settings, randomTarget]);

  const cardCount = splitLines(cards).length;
  const targetOk = site.trim().split("\n")[0]?.trim().length > 3;
  const poolCount = pool?.total ?? 0;
  const canStart = cardCount > 0 && (randomTarget ? poolCount > 0 : targetOk);

  const patchSettings = useCallback(
    (patch: Partial<RunSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  const handleStart = useCallback(() => {
    const store = site.trim().split("\n")[0]?.trim();
    const shared = {
      cards: splitLines(cards),
      proxy: settings.proxy.trim() || undefined,
      concurrency: settings.concurrency,
      retries: settings.retries,
      max_price: settings.maxPrice ? Number(settings.maxPrice) : undefined,
      endpoint: "check" as const,
    };

    if (randomTarget) {
      void start(
        { ...shared, mode: "card", sites: [], random_target: true },
        { label: `${cardCount} card(s) → ${poolCount} live site(s), one per card` },
      );
      return;
    }

    void start(
      { ...shared, mode: "card", sites: [store] },
      { label: `${cardCount} card(s) → ${store}` },
    );
  }, [site, cards, settings, start, cardCount, randomTarget, poolCount]);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Card validator
            </CardTitle>
            <CardDescription>
              {randomTarget
                ? "One task per card, each on its own store from the live pool — sweeps many gateways in a single run."
                : "One task per card, all against a single store — a quick way to sweep a list through one gateway."}
            </CardDescription>
          </div>
          <Badge variant={randomTarget ? "success" : "outline"}>
            {randomTarget ? "mode: card · random" : "mode: card"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Switch
                id="random-target"
                checked={randomTarget}
                onCheckedChange={setRandomTarget}
                aria-label="Random live site per card"
              />
              <button
                type="button"
                onClick={() => setRandomTarget((value) => !value)}
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
              >
                <Shuffle className="h-3.5 w-3.5 text-primary" />
                Random live site per card
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {randomTarget
                ? `${poolCount ? poolCount.toLocaleString() : "No"} live site(s) in the pool — each card is dealt a different one.`
                : "All cards run against the same store."}
            </p>
          </div>

          {!randomTarget ? <LiveSitesPicker onPick={setSite} selected={site} /> : null}

          <CardInput
            site={site}
            onSiteChange={setSite}
            cards={cards}
            onCardsChange={setCards}
            randomTarget={randomTarget}
            poolCount={poolCount}
            availableCards={health?.cards_loaded ?? 0}
            onLoadFromFile={async () => {
              const snapshot = await api.cards();
              if (!snapshot.cards.length) return;
              setCards(snapshot.cards.map((c) => `${c.number}|${c.month}|${c.year}|999`).join("\n"));
            }}
          />

          <RunSettingsFields
            value={settings}
            onChange={patchSettings}
            defaultMaxPrice={settingsData?.max_price}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground">{cardCount}</span> task(s) against{" "}
              {randomTarget ? (
                <>
                  <span className="font-mono text-foreground">
                    {poolCount ? poolCount.toLocaleString() : "—"}
                  </span>{" "}
                  live site(s), one per card
                </>
              ) : (
                <span className="font-mono text-foreground">{site.trim().split("\n")[0] || "—"}</span>
              )}
            </p>
            <Button onClick={handleStart} loading={starting} disabled={starting || !canStart}>
              Start card scan
            </Button>
          </div>
        </CardContent>
      </Card>

      <JobRunner
        jobId={jobId}
        stream={stream}
        onForget={() => {
          forget();
          setJobId(null);
        }}
        emptyHint={{
          icon: CreditCard,
          title: "No card scan yet",
          description:
            "Pick a target store — or switch on random targeting to use a different live store per card — paste your card list, then start.",
        }}
      />
    </div>
  );
}
