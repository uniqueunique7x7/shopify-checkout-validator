"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Ban,
  Download,
  ExternalLink,
  EyeOff,
  Pause,
  Play,
  RotateCcw,
  Search,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import {
  BUCKET_BADGE,
  bucketLabels,
  copyToClipboard,
  downloadText,
  formatDuration,
  formatNumber,
} from "@/lib/utils";
import type { Bucket, JobCounters, JobMode, JobStatus, ResultRecord } from "@/types/api";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/states";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { LogPanel, type LogLine } from "@/components/batch/log-panel";
import { StatStrip, StatTile } from "@/components/batch/stat-tile";

const TABS: { value: Bucket }[] = [{ value: "live" }, { value: "die" }, { value: "error" }];

export function JobMonitor({
  jobId,
  mode = "site",
  status,
  error,
  results,
  logs,
  total,
  completed,
  counters,
  elapsed,
  eta,
  progress,
  pauseRequested,
  connected,
  onRefresh,
  onCleared,
}: {
  jobId: string;
  /** Decides the wording of the three result buckets (card vs store verdicts). */
  mode?: JobMode;
  status: JobStatus;
  /** Set when the job stopped on its own — e.g. the backend restarted mid-run. */
  error?: string | null;
  results: ResultRecord[];
  logs: LogLine[];
  total: number;
  completed: number;
  counters: JobCounters;
  elapsed: number;
  eta: number | null;
  progress: number;
  pauseRequested: boolean;
  connected: boolean;
  onRefresh: () => void;
  onCleared: () => void;
}) {
  const [tab, setTab] = useState<Bucket>("live");
  const labels = bucketLabels(mode);
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<Bucket[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<null | "pause" | "resume" | "cancel" | "reset">(null);

  const active = status === "running" || status === "queued" || status === "paused";

  const byBucket = useMemo(() => {
    const map: Record<Bucket, ResultRecord[]> = { live: [], die: [], error: [] };
    for (const row of results) map[row.bucket]?.push(row);
    return map;
  }, [results]);

  const filtered = useMemo(() => {
    let rows = byBucket[tab];
    if (hidden.includes(tab)) rows = [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      [row.site, row.response, row.gate, row.product, row.card_full ?? row.card, row.detail ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [byBucket, tab, search, hidden]);

  const tabText = useMemo(
    () =>
      filtered
        .map((row) =>
          [row.site, row.response, row.gate, row.product && `$${row.price}`, row.card_full ?? row.card].filter(Boolean).join(" | "),
        )
        .join("\n"),
    [filtered],
  );

  async function control(action: "pause" | "resume" | "cancel") {
    setBusy(action);
    try {
      if (action === "pause") await api.pauseJob(jobId);
      if (action === "resume") await api.resumeJob(jobId);
      if (action === "cancel") await api.cancelJob(jobId);
      toast.success(
        action === "pause" ? "Pausing job" : action === "resume" ? "Job resumed" : "Cancellation requested",
      );
      onRefresh();
    } catch (error) {
      reportError(error, `Could not ${action} the job`);
    } finally {
      setBusy(null);
    }
  }

  async function copyLiveSites() {
    try {
      const text = await api.jobLiveSites(jobId);
      if (!text) {
        toast.info("No live sites in this job yet");
        return;
      }
      await copyToClipboard(text);
      toast.success(`Copied ${text.split("\n").length} live site(s)`);
    } catch (error) {
      reportError(error, "Could not fetch live sites");
    }
  }

  function exportTab() {
    if (!filtered.length) {
      toast.info("Nothing to export in this tab");
      return;
    }
    const header = "site\tresponse\tbucket\tgate\tproduct\tprice\tcard\ttime\tattempts\tstores";
    const rows = filtered.map((row) =>
      [
        row.site,
        row.response,
        row.bucket,
        row.gate,
        row.product,
        row.price,
        row.card_full ?? row.card,
        row.time,
        row.attempts,
        row.targets_tried ?? 1,
      ]
        .map((value) => String(value).replace(/\t/g, " ").replace(/\n/g, " "))
        .join("\t"),
    );
    downloadText(`job-${jobId}-${tab}.txt`, [header, ...rows].join("\n"), "text/plain");
  }

  return (
    <div className="space-y-3">
      <StatStrip>
        <StatTile label="Total" value={formatNumber(total)} />
        <StatTile label="Processed" value={formatNumber(completed)} tone="primary" />
        <StatTile label="Pending" value={formatNumber(Math.max(0, total - completed))} tone="warning" />
        <StatTile label={labels.live} value={formatNumber(counters.live)} tone="success" />
        <StatTile label={labels.die} value={formatNumber(counters.die)} tone="destructive" />
        <StatTile label={labels.error} value={formatNumber(counters.error)} tone="warning" />
        <StatTile label="Elapsed" value={formatDuration(elapsed)} />
        <StatTile label="Remaining" value={eta ? formatDuration(eta) : "—"} />
      </StatStrip>

      <Card>
        <CardContent className="space-y-3 p-3">
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <Badge
                variant={
                  status === "running"
                    ? "default"
                    : status === "completed"
                      ? "success"
                      : status === "failed"
                        ? "destructive"
                        : status === "paused"
                          ? "warning"
                          : "outline"
                }
              >
                {status}
              </Badge>
              <span className="font-mono text-muted-foreground">{jobId}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                {connected ? (
                  <>
                    <Wifi className="h-3 w-3 text-success" /> stream
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3 w-3 text-warning" /> polling
                  </>
                )}
              </span>
              {counters.retried > 0 ? (
                <span className="text-muted-foreground">
                  retries <span className="font-mono text-foreground">{counters.retried}</span>
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => control(pauseRequested ? "resume" : "pause")}
                disabled={!active || busy !== null}
                loading={busy === "pause" || busy === "resume"}
              >
                {pauseRequested ? <Play /> : <Pause />}
                {pauseRequested ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => control("cancel")}
                disabled={!active || busy !== null}
                loading={busy === "cancel"}
              >
                <Ban />
                Cancel
              </Button>
              <Button variant="ghost" size="sm" onClick={onRefresh}>
                Refresh
              </Button>
            </div>
          </div>

          <Progress
            value={progress}
            indicatorClassName={
              counters.error > 0 && counters.live === 0
                ? "bg-warning"
                : counters.live > 0
                  ? "bg-success"
                  : "bg-primary"
            }
          />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>
              {completed}/{total} tasks · {progress.toFixed(1)}%
            </span>
            <span className="font-mono">
              {(counters.live + counters.die + counters.error).toLocaleString()} classified
            </span>
          </div>
        </CardContent>
      </Card>

      <LogPanel lines={logs} title="Job log" height="h-56" />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Bucket)}>
            <TabsList>
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {labels[item.value]}
                  <span className="ml-1 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                    {byBucket[item.value].length}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <div className="relative w-full max-w-[220px]">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter this tab…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <Button variant="success" size="sm" onClick={copyLiveSites}>
              <ExternalLink />
              Copy live sites
            </Button>
            <Button variant="outline" size="sm" onClick={exportTab}>
              <Download />
              Export .txt
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setHidden((prev) => (prev.includes(tab) ? prev.filter((b) => b !== tab) : [...prev, tab]));
                toast.info(hidden.includes(tab) ? `${tab} results shown` : `${tab} results hidden`);
              }}
            >
              {hidden.includes(tab) ? <RotateCcw /> : <EyeOff />}
              {hidden.includes(tab) ? "Show" : "Hide"}
            </Button>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            {filtered.length === 0 ? (
              <EmptyState
                title={hidden.includes(tab) ? `Hidden ${labels[tab].toLowerCase()} results` : "Nothing here yet"}
                description={
                  hidden.includes(tab)
                    ? "Use Show to display them again — the data is still in the job."
                    : active
                      ? "Results stream in as tasks finish."
                      : "This job produced no results in this category."
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead className="w-16">Verdict</TableHead>
                    <TableHead>Response</TableHead>
                    <TableHead>Gateway</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="w-20">Price</TableHead>
                    <TableHead>Card</TableHead>
                    <TableHead className="w-16">Time</TableHead>
                    <TableHead className="w-20">Attempts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => (
                    <TableRow key={`${row.index}-${row.site}`}>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {row.index + 1}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate">
                        <a
                          href={row.site}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {row.site.replace(/^https?:\/\//, "")}
                        </a>
                        {(row.targets_tried ?? 1) > 1 ? (
                          <span
                            className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                            title={`Rechecked across ${row.targets_tried} store(s) until it earned a verdict`}
                          >
                            ×{row.targets_tried} stores
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${BUCKET_BADGE[row.bucket]}`}
                        >
                          {labels[row.bucket]}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{row.response}</TableCell>
                      <TableCell className="text-xs">{row.gate || "—"}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs">{row.product || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">${row.price}</TableCell>
                      <TableCell className="font-mono text-[11px]">{row.card_full || row.card || "—"}</TableCell>
                      <TableCell className="font-mono text-[11px]">{row.time}</TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {row.attempts > 1 ? <span className="text-warning">{row.attempts}×</span> : row.attempts}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </motion.div>
        </AnimatePresence>

        {tabText ? (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} row(s) in this view
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await copyToClipboard(tabText);
                  toast.success("Tab contents copied");
                }}
              >
                Copy lines
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
                Clear tab
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <ConfirmationDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Clear ${labels[tab].toLowerCase()} results?`}
        description="Results stay stored on the server (they are part of the job and the history file) — this only hides them in the current view. Use Show to bring them back."
        confirmLabel="Clear view"
        onConfirm={() => {
          setHidden((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
          setConfirmClear(false);
          toast.success(`${labels[tab]} results hidden`, {
            description: "They remain available in the CSV/JSON export.",
          });
          onCleared();
        }}
      />
    </div>
  );
}
