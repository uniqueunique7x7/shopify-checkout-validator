"use client";

import Link from "next/link";
import useSWR from "swr";
import { Activity, RefreshCcw } from "lucide-react";

import { api } from "@/lib/api";
import { bucketLabels, formatDateTime, formatDuration, formatNumber, jobHref } from "@/lib/utils";
import type { JobStatus } from "@/types/api";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { TableSkeleton } from "@/components/ui/skeleton";

const STATUS_VARIANT: Record<JobStatus, "default" | "success" | "destructive" | "warning" | "outline"> = {
  queued: "outline",
  running: "default",
  paused: "warning",
  completed: "success",
  failed: "destructive",
  cancelled: "outline",
};

export default function JobsPage() {
  const { data, error, isLoading, mutate } = useSWR("jobs:list", () => api.jobs(100), {
    refreshInterval: 5000,
  });

  const counts = data?.counts ?? {};

  return (
    <>
      <PageHeader
        eyebrow="Jobs"
        title="Job history"
        description="Every batch run, with live counters, results and logs. Click a job to reopen its monitor."
        actions={
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCcw />
            Refresh
          </Button>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {(["running", "queued", "paused", "completed", "failed", "cancelled"] as const).map((status) => (
          <Card key={status} className="p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{status}</p>
            <p className="mt-0.5 font-mono text-lg font-semibold">{formatNumber(counts[status] ?? 0)}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <ErrorState message={(error as Error).message} onRetry={() => mutate()} />
        ) : isLoading ? (
          <TableSkeleton rows={5} cols={7} />
        ) : !data?.items.length ? (
          <EmptyState
            icon={Activity}
            title="No jobs yet"
            description="Start a job from the site or card validator — it will appear here with live progress."
            action={
              <Button asChild size="sm">
                <Link href="/site-validator">Open site validator</Link>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[180px]">Progress</TableHead>
                  <TableHead>Tasks</TableHead>
                  <TableHead>Results</TableHead>
                  <TableHead>Workers</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-[11px]">{job.id}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <Progress
                        value={job.progress}
                        indicatorClassName={job.status === "failed" ? "bg-destructive" : undefined}
                      />
                      <span className="mt-1 block text-[10px] text-muted-foreground">{job.progress.toFixed(0)}%</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {job.completed}/{job.total}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <span
                        className="text-success"
                        title={`${job.counters.live} ${bucketLabels(job.params.mode).live.toLowerCase()}`}
                      >
                        {job.counters.live}
                      </span>{" "}
                      /{" "}
                      <span
                        className="text-destructive"
                        title={`${job.counters.die} ${bucketLabels(job.params.mode).die.toLowerCase()}`}
                      >
                        {job.counters.die}
                      </span>{" "}
                      /{" "}
                      <span className="text-warning" title={`${job.counters.error} error(s)`}>
                        {job.counters.error}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.params.concurrency}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(job.created_at)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatDuration(job.elapsed)}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={jobHref(job.id, job.params.mode)}>Open</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
