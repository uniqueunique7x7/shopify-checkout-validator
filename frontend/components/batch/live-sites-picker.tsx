"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, RefreshCcw, Search, Sparkles, Store, X } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { cn, formatNumber, formatRelative } from "@/lib/utils";
import type { LiveSiteEntry } from "@/types/api";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

const PAGE_SIZE = 50;
/** Max rows mounted in the DOM at once, whatever the pool size. */
const WINDOW_SIZE = 200;
const ROW_HEIGHT = 52;

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Picks a target store for the card validator out of the live-sites pool.
 *
 * Scales to very large pools:
 *   * search and paging are server-side — only one page of 50 is ever transferred
 *   * pages accumulate, but a fixed window of rows is mounted in the DOM
 *   * the list is a fixed-height scroller, so layout cost stays constant
 */
export function LiveSitesPicker({
  onPick,
  selected,
}: {
  onPick: (site: string) => void;
  selected: string;
}) {
  const [rawSearch, setRawSearch] = useState("");
  const search = useDebounced(rawSearch, 300);
  const [source, setSource] = useState<"all" | "jobs" | "history">("all");

  const [entries, setEntries] = useState<LiveSiteEntry[]>([]);
  const [meta, setMeta] = useState({ total: 0, totalUnfiltered: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // guards against out-of-order responses while typing fast
  const requestId = useRef(0);

  const loadPage = useCallback(
    async (offset: number, replace: boolean, opts?: { refresh?: boolean }) => {
      const id = ++requestId.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await api.liveSitesPool({
          source,
          offset,
          limit: PAGE_SIZE,
          search,
          includeRunning: true,
          refresh: opts?.refresh,
        });
        if (id !== requestId.current) return; // superseded by a newer request
        setEntries((prev) => (replace ? page.items : [...prev, ...page.items]));
        setMeta({ total: page.total, totalUnfiltered: page.total_unfiltered, hasMore: page.has_more });
        setError(null);
        if (replace && scrollerRef.current) {
          scrollerRef.current.scrollTop = 0;
        }
        setScrollTop(0);
      } catch (caught) {
        if (id !== requestId.current) return;
        setError(caught instanceof Error ? caught.message : "Could not load live sites");
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [source, search],
  );

  // reload the first page whenever the query or source changes, and rewind
  // the scroller immediately so the virtual window cannot stay parked past
  // the end of a shorter result set
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    setScrollTop(0);
    void loadPage(0, true);
  }, [loadPage]);

  // keep the pool reasonably fresh while it is on screen (one small page per tick)
  useEffect(() => {
    const timer = setInterval(() => void loadPage(0, true), 30000);
    return () => clearInterval(timer);
  }, [loadPage]);

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      setScrollTop(el.scrollTop);
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400;
      if (nearBottom && meta.hasMore && !loadingMore && !loading) {
        void loadPage(entries.length, false);
      }
    },
    [entries.length, loadPage, loading, loadingMore, meta.hasMore],
  );

  // --- virtual window ----------------------------------------------------
  const { startIndex, visible, topPad, bottomPad } = useMemo(() => {
    // clamp against the live length: a shorter list must not leave the window
    // parked past the end, or nothing renders at all
    const maxStart = Math.max(0, entries.length - WINDOW_SIZE);
    const first = Math.max(0, Math.min(Math.floor(scrollTop / ROW_HEIGHT), maxStart));
    const start = Math.max(0, Math.min(first - 4, maxStart));
    const slice = entries.slice(start, start + WINDOW_SIZE);
    return {
      startIndex: start,
      visible: slice,
      topPad: start * ROW_HEIGHT,
      bottomPad: Math.max(0, (entries.length - start - slice.length) * ROW_HEIGHT),
    };
  }, [entries, scrollTop]);

  const selectedKey = selected.trim().replace(/\/$/, "").toLowerCase();

  async function pickRandom() {
    try {
      const head = await api.liveSitesPool({ source, limit: 1, offset: 0, search, refresh: true });
      if (!head.total) {
        toast.info("No live sites available yet", { description: "Run a site scan first." });
        return;
      }
      const offset = Math.floor(Math.random() * head.total);
      const pick = await api.liveSitesPool({ source, limit: 1, offset, search });
      const choice = pick.items[0];
      if (!choice) return;
      onPick(choice.site);
      toast.success("Target set", { description: choice.site });
    } catch (caught) {
      reportError(caught, "Could not pick a random site");
    }
  }

  async function copyAll() {
    try {
      const page = await api.liveSitesPool({ source, limit: 1000, offset: 0, search, refresh: true });
      if (!page.count) {
        toast.info("Nothing to copy yet");
        return;
      }
      await navigator.clipboard.writeText(page.sites.join("\n"));
      toast.success(
        page.total > page.count
          ? `Copied the first ${formatNumber(page.count)} of ${formatNumber(page.total)} sites`
          : `Copied ${formatNumber(page.count)} live site(s)`,
      );
    } catch (caught) {
      reportError(caught, "Could not copy the live sites");
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-4 w-4 text-primary" />
            Live site pool
          </CardTitle>
          <CardDescription>
            Stores that already returned approved-class evidence in a site scan — pick one as your target,
            no need to re-scan.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={meta.totalUnfiltered ? "success" : "outline"}>
            {loading ? "…" : `${formatNumber(meta.total)} live`}
          </Badge>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => void loadPage(0, true, { refresh: true })}
            title="Refresh pool"
            aria-label="Refresh pool"
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              placeholder="Search live sites, gateways, responses…"
              className="h-8 pl-7 pr-7 text-xs"
            />
            {rawSearch ? (
              <button
                type="button"
                onClick={() => setRawSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex overflow-hidden rounded-md border border-border text-[11px]">
            {(["all", "jobs", "history"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setSource(value)}
                className={cn(
                  "px-2.5 py-1.5 uppercase tracking-wide transition-colors",
                  source === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={pickRandom} disabled={!meta.total}>
            <Sparkles />
            Random
          </Button>
          <Button variant="outline" size="sm" onClick={copyAll} disabled={!meta.total}>
            Copy all
          </Button>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={() => void loadPage(0, true)} />
        ) : loading ? (
          <LoadingState label="Loading live sites…" />
        ) : !meta.total ? (
          <EmptyState
            icon={Store}
            title={search ? "No stores match that search" : "No live sites yet"}
            description={
              search
                ? `Nothing in the pool matches “${search}”.`
                : "Run a site scan on the Site validator page. Any store that answers with approved-class evidence shows up here and stays available across restarts."
            }
          />
        ) : (
          <>
            <div
              ref={scrollerRef}
              onScroll={onScroll}
              className="h-64 overflow-y-auto rounded-md border border-border"
            >
              <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
                <ul className="divide-y divide-border">
                  {visible.map((entry, i) => (
                    <LiveSiteRow
                      key={`${entry.site}-${startIndex + i}`}
                      entry={entry}
                      active={entry.site.trim().replace(/\/$/, "").toLowerCase() === selectedKey}
                      onPick={onPick}
                    />
                  ))}
                </ul>
              </div>
              {loadingMore ? (
                <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading more…
                </p>
              ) : null}
            </div>

            <p className="text-[11px] text-muted-foreground">
              {formatNumber(meta.total)} match(es)
              {meta.total !== meta.totalUnfiltered
                ? ` of ${formatNumber(meta.totalUnfiltered)} in pool`
                : ""} · loaded {formatNumber(entries.length)} ·{" "}
              {formatNumber(Math.min(WINDOW_SIZE, entries.length))} row(s) in the DOM · source{" "}
              <span className="font-mono">{source}</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LiveSiteRow({
  entry,
  active,
  onPick,
}: {
  entry: LiveSiteEntry;
  active: boolean;
  onPick: (site: string) => void;
}) {
  return (
    <li style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        onClick={() => onPick(entry.site)}
        className={cn(
          "flex h-full w-full items-center gap-3 px-3 text-left transition-colors hover:bg-accent",
          active && "bg-accent",
        )}
      >
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            active ? "border-success bg-success/20 text-success" : "border-border",
          )}
        >
          {active ? <Check className="h-3 w-3" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{entry.site.replace(/^https?:\/\//, "")}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {entry.gate} · {entry.responses.join(", ")}
            {entry.errors ? <span className="text-warning"> · {entry.errors} error(s)</span> : null}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-[11px] text-muted-foreground">{formatRelative(entry.last_seen)}</span>
          {entry.price && entry.price !== "0.00" ? (
            <span className="block font-mono text-[11px] text-muted-foreground">${entry.price}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
