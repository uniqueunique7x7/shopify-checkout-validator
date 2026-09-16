"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Download, History as HistoryIcon, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { BucketBadge, ResponseBadge } from "@/components/ui/bucket-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { TableSkeleton } from "@/components/ui/skeleton";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { StatStrip, StatTile } from "@/components/batch/stat-tile";

const PAGE_SIZE = 50;

export default function HistoryPage() {
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<string>("all");
  const [response, setResponse] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);

  const key = useMemo(
    () => ["history", { search, bucket, response, page }] as const,
    [search, bucket, response, page],
  );

  const { data, error, isLoading, mutate } = useSWR(
    key,
    () =>
      api.history({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: search || undefined,
        bucket: bucket === "all" ? undefined : bucket,
        response: response === "all" ? undefined : response,
      }),
    { refreshInterval: 15000 },
  );

  const { data: summary, mutate: mutateSummary } = useSWR("history:summary", api.historySummary, {
    refreshInterval: 15000,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  async function clearHistory() {
    try {
      const result = await api.clearHistory();
      toast.success(`Deleted ${result.deleted} history entr(ies)`);
      setConfirmClear(false);
      await Promise.all([mutate(), mutateSummary()]);
    } catch (caught) {
      reportError(caught, "Could not clear history");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="History"
        title="Execution history"
        description="Every single check and batch task is persisted to a local JSON file — no database required."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(api.historyExportUrl("txt"), "_blank")}
            >
              <Download />
              TXT
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(api.historyExportUrl("json"), "_blank")}
            >
              <Download />
              JSON
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmClear(true)}>
              <Trash2 />
              Clear
            </Button>
          </div>
        }
      />

      <div className="mb-3">
        <StatStrip>
          <StatTile label="Entries" value={formatNumber(summary?.count ?? 0)} />
          <StatTile label="Live / Success" value={formatNumber(summary?.buckets.live ?? 0)} tone="success" />
          <StatTile label="Die / Declined" value={formatNumber(summary?.buckets.die ?? 0)} tone="destructive" />
          <StatTile label="Errors" value={formatNumber(summary?.buckets.error ?? 0)} tone="warning" />
          <StatTile label="Distinct gates" value={formatNumber(Object.keys(summary?.gates ?? {}).length)} />
          <StatTile label="Distinct codes" value={formatNumber(Object.keys(summary?.responses ?? {}).length)} />
          <StatTile
            label="Top response"
            value={<span className="text-[13px]">{Object.entries(summary?.responses ?? {})[0]?.[0] ?? "—"}</span>}
          />
          <StatTile
            label="Top gateway"
            value={<span className="text-[13px]">{Object.entries(summary?.gates ?? {})[0]?.[0] ?? "—"}</span>}
          />
        </StatStrip>
      </div>

      <Card className="mb-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Search store, card, gateway, product…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Select
            value={bucket}
            onValueChange={(value) => {
              setBucket(value);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder="Verdict" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All verdicts</SelectItem>
              <SelectItem value="live">Live / Success</SelectItem>
              <SelectItem value="die">Die / Declined</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={response}
            onValueChange={(value) => {
              setResponse(value);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue placeholder="Response" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All responses</SelectItem>
              {Object.entries(summary?.responses ?? {}).map(([code, count]) => (
                <SelectItem key={code} value={code}>
                  {code} ({count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {formatNumber(data?.total ?? 0)} entr{data?.total === 1 ? "y" : "ies"}
            </span>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              ‹
            </Button>
            <span className="font-mono">
              {page + 1}/{totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              ›
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {error ? (
          <ErrorState message={(error as Error).message} onRetry={() => mutate()} />
        ) : isLoading ? (
          <TableSkeleton rows={8} cols={8} />
        ) : !data?.items.length ? (
          <EmptyState
            icon={HistoryIcon}
            title="No history entries"
            description="Run a check or a batch job and the results will show up here."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">When</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead className="w-16">Verdict</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead>Gateway</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="w-20">Price</TableHead>
                  <TableHead>Card</TableHead>
                  <TableHead className="w-20">Origin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="text-[11px] text-muted-foreground" title={formatDateTime(item.ts)}>
                      {formatRelative(item.ts)}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs">
                      <a href={item.site} target="_blank" rel="noreferrer" className="hover:text-primary hover:underline">
                        {item.site?.replace(/^https?:\/\//, "") || "—"}
                      </a>
                    </TableCell>
                    <TableCell>
                      <BucketBadge bucket={item.bucket} mode={item.mode} />
                    </TableCell>
                    <TableCell>
                      <ResponseBadge response={item.response} bucket={item.bucket} />
                    </TableCell>
                    <TableCell className="text-xs">{item.gate || "—"}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">{item.product || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">${item.price}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{item.card_masked}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{item.origin}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > PAGE_SIZE ? (
          <CardContent className="flex items-center justify-between border-t border-border py-2 text-xs text-muted-foreground">
            <span>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {formatNumber(data.total)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(0)} disabled={page === 0}>
                First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(totalPages - 1)}
                disabled={page >= totalPages - 1}
              >
                Last
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <ConfirmationDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Delete the entire history?"
        description="This removes every stored execution record from the local JSON file. Exported files are not affected."
        confirmLabel="Delete history"
        destructive
        onConfirm={clearHistory}
      />
    </>
  );
}
