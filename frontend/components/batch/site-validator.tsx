"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Store } from "lucide-react";

import { api } from "@/lib/api";
import { cleanSiteList, splitLines } from "@/lib/utils";

import { RunSettingsFields, DEFAULT_RUN_SETTINGS, type RunSettings } from "@/components/batch/run-settings";
import { SiteInput } from "@/components/batch/site-input";
import { JobRunner } from "@/components/batch/job-runner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useJobStream } from "@/hooks/use-job-stream";
import { useJobLauncher } from "@/hooks/use-job-launcher";

const STORAGE_KEY = "shopify-validator:site-validator";

/** Scan many stores and report which ones have a live Shopify Payments gateway. */
export function SiteValidator({ initialJobId = null }: { initialJobId?: string | null }) {
  const [sites, setSites] = useState("");
  const [card, setCard] = useState("");
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_RUN_SETTINGS);
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
  const stream = useJobStream(jobId, { resumeLast: STORAGE_KEY, onResume: setJobId });
  const { start, starting, forget } = useJobLauncher(setJobId);

  // restore the last inputs so a refresh does not lose the list
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY + ":inputs") ?? "null");
      if (saved) {
        setSites(saved.sites ?? "");
        setCard(saved.card ?? "");
        setSettings((prev) => ({ ...prev, ...(saved.settings ?? {}) }));
      }
    } catch {
      /* ignore malformed state */
    }
  }, []);

  useEffect(() => {
    const payload = JSON.stringify({ sites, card, settings });
    const timer = setTimeout(() => window.localStorage.setItem(STORAGE_KEY + ":inputs", payload), 400);
    return () => clearTimeout(timer);
  }, [sites, card, settings]);

  const siteCount = splitLines(sites).length;

  const patchSettings = useCallback(
    (patch: Partial<RunSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  const handleStart = useCallback(() => {
    const list = splitLines(cleanSiteList(sites));
    const cardLines = splitLines(card);
    void start(
      {
        mode: "site",
        sites: list,
        cards: cardLines,
        proxy: settings.proxy.trim() || undefined,
        concurrency: settings.concurrency,
        retries: settings.retries,
        max_price: settings.maxPrice ? Number(settings.maxPrice) : undefined,
        endpoint: "check",
      },
      { label: `${list.length} store(s)` },
    );
  }, [sites, card, settings, start]);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-4 w-4 text-primary" />
              Site validator
            </CardTitle>
            <CardDescription>
              One task per store — checks whether the store&apos;s Shopify Payments gateway accepts a card at all.
            </CardDescription>
          </div>
          <Badge variant="outline">mode: site</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <SiteInput
            sites={sites}
            onSitesChange={setSites}
            card={card}
            onCardChange={setCard}
            availableCards={health?.cards_loaded ?? 0}
            onLoadFromFile={async () => {
              const snapshot = await api.cards();
              if (!snapshot.cards.length) return;
              setCard(snapshot.cards.map((c) => `${c.number}|${c.month}|${c.year}|999`).join("\n"));
            }}
          />

          <RunSettingsFields
            value={settings}
            onChange={patchSettings}
            defaultMaxPrice={settingsData?.max_price}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground">{siteCount}</span> task(s) · results stream in live
            </p>
            <Button onClick={handleStart} loading={starting} disabled={starting || siteCount === 0}>
              Start site scan
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
          icon: Store,
          title: "No site scan yet",
          description:
            "Paste a list of stores and start a scan. Each store gets one task; the result tells you whether its gateway is live.",
        }}
      />
    </div>
  );
}
