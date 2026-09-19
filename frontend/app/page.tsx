"use client";

import useSWR from "swr";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, lazy } from "react";
import { Activity, CreditCard, Database, Gauge, Store } from "lucide-react";

import { api } from "@/lib/api";
import { formatNumber, jobHref } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

const ValidateForm = lazy(() =>
  import("@/components/validate/validate-form").then((mod) => ({ default: mod.ValidateForm })),
);

function DashboardContent() {
  const params = useSearchParams();
  const initialSite = params.get("site") ?? "";
  const { data: stats } = useSWR("stats", api.stats, { refreshInterval: 10000 });
  const { data: health } = useSWR("health", api.health, { refreshInterval: 8000 });
  const { data: jobs } = useSWR("jobs", () => api.jobs(5), { refreshInterval: 5000 });

  const tiles = [
    {
      label: "Checks run",
      value: formatNumber(stats?.stats.total_checks ?? 0),
      icon: Gauge,
      hint: "Total validations since boot",
    },
    {
      label: "Live results",
      value: formatNumber(stats?.history.buckets.live ?? 0),
      icon: Activity,
      hint: "Approved-class evidence in history",
    },
    {
      label: "Cards loaded",
      value: formatNumber(health?.cards_loaded ?? 0),
      icon: CreditCard,
      hint: "Entries parsed from cards.txt",
    },
    {
      label: "Cached stores",
      value: formatNumber(health?.cache_entries ?? 0),
      icon: Database,
      hint: `Product cache TTL ${health?.cache_ttl ?? 0}s`,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Validate a Shopify checkout"
        description="Run the async engine against a single store, or jump into a validator for multi-store jobs."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/site-validator">
                <Store />
                Site validator
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/card-validator">
                <CreditCard />
                Card validator
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{tile.label}</p>
                <div className="mt-1 h-6 font-mono text-xl font-semibold">
                  {stats || health ? tile.value : <Skeleton className="h-6 w-16" />}
                </div>
              </div>
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <tile.icon className="h-3.5 w-3.5" />
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{tile.hint}</p>
          </Card>
        ))}
      </div>

      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <ValidateForm initialSite={initialSite} />
      </Suspense>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Recent jobs</CardTitle>
              <CardDescription>Newest batch runs</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/jobs">All jobs</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {!jobs ? (
              <Skeleton className="h-16 w-full" />
            ) : jobs.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">No jobs yet. Start one from a validator.</p>
            ) : (
              jobs.items.map((job) => (
                <Link
                  key={job.id}
                  href={jobHref(job.id, job.params.mode)}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs transition-colors hover:bg-accent"
                >
                  <span className="font-mono">{job.id}</span>
                  <span className="text-muted-foreground">
                    {job.completed}/{job.total}
                  </span>
                  <Badge
                    variant={
                      job.status === "completed"
                        ? "success"
                        : job.status === "running"
                          ? "default"
                          : job.status === "failed"
                            ? "destructive"
                            : "outline"
                    }
                  >
                    {job.status}
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Response distribution</CardTitle>
            <CardDescription>All-time codes recorded in history</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {!stats ? (
              <Skeleton className="h-24 w-full" />
            ) : Object.keys(stats.history.responses).length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              Object.entries(stats.history.responses)
                .slice(0, 9)
                .map(([code, count]) => {
                  const total = stats.history.count || 1;
                  return (
                    <div key={code} className="flex items-center gap-3 text-xs">
                      <span className="w-40 shrink-0 truncate font-mono">{code}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(3, (count / total) * 100)}%` }}
                        />
                      </span>
                      <span className="w-10 shrink-0 text-right font-mono text-muted-foreground">{count}</span>
                    </div>
                  );
                })
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <DashboardContent />
    </Suspense>
  );
}
