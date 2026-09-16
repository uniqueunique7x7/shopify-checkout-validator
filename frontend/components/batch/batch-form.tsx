"use client";

import { useState } from "react";
import { Eraser, TriangleAlert, Wand2 } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";

import { api } from "@/lib/api";
import { cleanCardList, cleanSiteList, splitLines } from "@/lib/utils";
import type { JobCreateRequest, JobMode } from "@/types/api";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadFileButton } from "@/components/ui/load-file-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { InfoTip } from "@/components/ui/tooltip";
import { modeTaskCount } from "@/components/batch/bulk-checker";

export interface BatchFormValues {
  sites: string;
  cards: string;
  proxy: string;
  concurrency: number;
  retries: number;
  maxPrice: string;
  endpoint: "check" | "shopify";
  pinnedVariant: string;
}

const COPY: Record<JobMode, { title: string; description: string; sitesLabel: string; sitesHint?: string; cardsLabel: string; cardsHint?: string }> = {
  site: {
    title: "Stores",
    description: "One task per store. The card below is optional — leave it blank to use cards.txt.",
    sitesLabel: "Stores",
    cardsLabel: "Card (optional)",
    cardsHint: "blank = random from cards.txt",
  },
  card: {
    title: "Cards against one store",
    description: "Every card runs against the first store in the list, so the gateway is hit repeatedly.",
    sitesLabel: "Target store",
    sitesHint: "exactly one",
    cardsLabel: "Cards",
  },
  pair: {
    title: "Paired lists",
    description: "Stores and cards are matched by index; the shorter list repeats.",
    sitesLabel: "Stores",
    cardsLabel: "Cards",
  },
};

export function BatchForm({
  onStart,
  starting,
  disabled,
  initial,
  mode = "pair",
}: {
  onStart: (payload: Omit<JobCreateRequest, "mode">) => void;
  starting: boolean;
  disabled?: boolean;
  initial?: Partial<BatchFormValues>;
  mode?: JobMode;
}) {
  const { data: settings } = useSWR("settings", api.settings);
  const copy = COPY[mode];

  const [values, setValues] = useState<BatchFormValues>({
    sites: initial?.sites ?? "",
    cards: initial?.cards ?? "",
    proxy: initial?.proxy ?? "",
    concurrency: initial?.concurrency ?? 3,
    retries: initial?.retries ?? 1,
    maxPrice: initial?.maxPrice ?? "",
    endpoint: initial?.endpoint ?? "check",
    pinnedVariant: initial?.pinnedVariant ?? "",
  });

  const siteCount = splitLines(values.sites).length;
  const cardCount = splitLines(values.cards).length;
  const taskCount = modeTaskCount(mode, values.sites, values.cards);

  function update<K extends keyof BatchFormValues>(key: K, value: BatchFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleCleanSites() {
    const cleaned = cleanSiteList(values.sites);
    const before = splitLines(values.sites).length;
    const after = splitLines(cleaned).length;
    update("sites", cleaned);
    if (!before) return;
    toast.success(`Kept ${after} of ${before} lines`, {
      description: after < before ? `${before - after} line(s) dropped as invalid or duplicate.` : "No changes needed.",
    });
  }

  function handleCleanCards() {
    const cleaned = cleanCardList(values.cards);
    const before = splitLines(values.cards).length;
    const after = splitLines(cleaned).length;
    update("cards", cleaned);
    if (!before) return;
    toast.success(`Kept ${after} of ${before} cards`, {
      description: after < before ? `${before - after} line(s) dropped as invalid or duplicate.` : "No changes needed.",
    });
  }

  function applySiteFile(text: string, fileName: string) {
    const cleaned = cleanSiteList(text);
    // card mode only ever targets one store
    const value = mode === "card" ? (splitLines(cleaned)[0] ?? "") : cleaned;
    const count = splitLines(value).length;
    if (!count) {
      toast.error(`${fileName} had no usable store lines`);
      return;
    }
    update("sites", value);
    toast.success(`Loaded ${count} store(s) from ${fileName}`);
  }

  function applyCardFile(text: string, fileName: string) {
    const cleaned = cleanCardList(text);
    const count = splitLines(cleaned).length;
    if (!count) {
      toast.error(`${fileName} had no usable card lines`);
      return;
    }
    update("cards", cleaned);
    toast.success(`Loaded ${count} card(s) from ${fileName}`);
  }

  async function loadFromFile() {
    try {
      const snapshot = await api.cards();
      if (!snapshot.cards.length) {
        toast.info("cards.txt is empty", { description: snapshot.path });
        return;
      }
      const lines = snapshot.cards.map((card) => `${card.number}|${card.month}|${card.year}|999`);
      update("cards", lines.join("\n"));
      toast.warning("Loaded masked cards for reference only", {
        description: "CVVs are stored masked — these lines will not pass validation. Type real cards here.",
      });
    } catch {
      toast.error("Could not read cards.txt");
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const sites = splitLines(values.sites);
    const cards = splitLines(values.cards);

    if (mode === "card") {
      if (!sites.length) {
        toast.error("Add the target store");
        return;
      }
      if (!cards.length) {
        toast.error("Add at least one card");
        return;
      }
    } else if (!sites.length) {
      toast.error("Add at least one store");
      return;
    }

    onStart({
      sites,
      cards,
      proxy: values.proxy.trim() || undefined,
      concurrency: values.concurrency,
      retries: values.retries,
      max_price: values.maxPrice ? Number(values.maxPrice) : undefined,
      variant_id: values.pinnedVariant.trim() || undefined,
      endpoint: values.endpoint,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sites" hint={copy.sitesHint ?? `${siteCount} line(s)`}>
                {copy.sitesLabel}
              </Label>
              <Textarea
                id="sites"
                value={values.sites}
                onChange={(e) => update("sites", mode === "card" ? e.target.value.split("\n")[0] ?? "" : e.target.value)}
                placeholder={
                  mode === "card"
                    ? "store-to-test.myshopify.com"
                    : "store-a.myshopify.com\nhttps://store-b.com\nbrand.com|some|extra|columns"
                }
                className={`mono-input ${mode === "card" ? "h-[46px]" : "h-[190px]"}`}
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-2">
                {mode !== "card" ? (
                  <Button type="button" variant="outline" size="sm" onClick={handleCleanSites}>
                    <Wand2 />
                    Clean URLs
                  </Button>
                ) : null}
                <LoadFileButton
                  onLoad={applySiteFile}
                  label={mode === "card" ? "Load store from file" : "Load stores from file"}
                  title="Load a .txt file of stores from disk"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cards" hint={copy.cardsHint ?? `${cardCount} line(s)`}>
                {copy.cardsLabel}
              </Label>
              <Textarea
                id="cards"
                value={values.cards}
                onChange={(e) => update("cards", e.target.value)}
                placeholder={"4111111111111111|12|30|123\n5424180011223344|05|2027|999"}
                className={`mono-input ${mode === "site" ? "h-[90px]" : "h-[190px]"}`}
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleCleanCards}>
                  <Wand2 />
                  Clean cards
                </Button>
                <LoadFileButton
                  onLoad={applyCardFile}
                  label="Load cards from file"
                  title="Load a .txt file of cards from disk"
                />
                <Button type="button" variant="ghost" size="sm" onClick={loadFromFile}>
                  Copy from cards.txt
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {mode === "card"
                  ? "Every card above runs against that single store."
                  : mode === "site"
                    ? "Leave blank to let the engine pick a card from cards.txt per store."
                    : "Both lists are paired by index; the shorter one repeats."}
              </p>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-1.5">
              <Label htmlFor="endpoint">Endpoint</Label>
              <Select value={values.endpoint} onValueChange={(value) => update("endpoint", value as "check" | "shopify")}>
                <SelectTrigger id="endpoint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">/check — probe</SelectItem>
                  <SelectItem value="shopify">/shopify — full submit</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="concurrency">
                Workers
                <InfoTip>
                  Parallel tasks inside the job. Each store also has its own server-side request semaphore.
                </InfoTip>
              </Label>
              <Select value={String(values.concurrency)} onValueChange={(value) => update("concurrency", Number(value))}>
                <SelectTrigger id="concurrency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 5, 8, 12, 20, 30, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} {n === 1 ? "worker" : "workers"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="retries">
                Retries
                <InfoTip>Attempts per task. Only error-classified results are retried.</InfoTip>
              </Label>
              <Select value={String(values.retries)} onValueChange={(value) => update("retries", Number(value))}>
                <SelectTrigger id="retries">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="max-price" hint={`default ${settings?.max_price ?? "—"}`}>
                Max price
              </Label>
              <Input
                id="max-price"
                type="number"
                min={1}
                value={values.maxPrice}
                onChange={(e) => update("maxPrice", e.target.value)}
                placeholder={settings ? String(settings.max_price) : "500"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="proxy" hint="optional">
                Proxy
              </Label>
              <Input
                id="proxy"
                value={values.proxy}
                onChange={(e) => update("proxy", e.target.value)}
                placeholder="host:port:user:pass"
                className="font-mono"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="variant" hint="optional">
                Pin variant ID
              </Label>
              <Input
                id="variant"
                value={values.pinnedVariant}
                onChange={(e) => update("pinnedVariant", e.target.value)}
                placeholder="auto (cheapest)"
                className="font-mono"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {taskCount > 0 ? (
                <>
                  <span className="font-mono text-foreground">{taskCount}</span> task(s) will be queued
                  {mode === "pair"
                    ? ` · ${siteCount} store(s) × ${cardCount} card(s)`
                    : mode === "card"
                      ? ` · ${cardCount} card(s) on 1 store`
                      : " · one per store"}
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 text-warning" />
                  {mode === "card" ? "Add a target store and at least one card." : "Paste at least one store to start."}
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setValues((prev) => ({ ...prev, sites: "", cards: "", proxy: "", pinnedVariant: "" }))
                }
              >
                <Eraser />
                Clear inputs
              </Button>
              <Button type="submit" loading={starting} disabled={disabled || taskCount === 0}>
                Start job
              </Button>            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
