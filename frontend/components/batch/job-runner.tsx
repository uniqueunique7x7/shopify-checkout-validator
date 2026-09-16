"use client";

import type { LucideIcon } from "lucide-react";

import { JobMonitor } from "@/components/batch/job-monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import type { useJobStream } from "@/hooks/use-job-stream";

/** Renders whichever of the three states a job stream is in. */
export function JobRunner({
  jobId,
  stream,
  onForget,
  emptyHint,
}: {
  jobId: string | null;
  stream: ReturnType<typeof useJobStream>;
  onForget: () => void;
  emptyHint: { icon: LucideIcon; title: string; description: string };
}) {
  if (!jobId) {
    return (
      <Card>
        <CardContent className="pt-4">
          <EmptyState icon={emptyHint.icon} title={emptyHint.title} description={emptyHint.description} />
        </CardContent>
      </Card>
    );
  }

  if (!stream.job) {
    return (
      <Card>
        {stream.error ? (
          <>
            <ErrorState title="Job unavailable" message={stream.error} onRetry={() => void stream.refresh()} />
            <div className="flex justify-center pb-4">
              <Button variant="outline" size="sm" onClick={onForget}>
                Clear selection and start a new job
              </Button>
            </div>
          </>
        ) : (
          <CardContent className="pt-4">
            <Skeleton className="h-40 w-full" />
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <JobMonitor
      jobId={jobId}
      mode={stream.job.params.mode}
      status={stream.status ?? stream.job.status}
      results={stream.results}
      logs={stream.logs}
      total={stream.job.total}
      completed={stream.job.completed}
      counters={stream.job.counters}
      elapsed={stream.job.elapsed}
      eta={stream.job.eta}
      progress={stream.job.progress}
      pauseRequested={stream.job.pause_requested}
      connected={stream.connected}
      onRefresh={() => void stream.refresh()}
      onCleared={() => undefined}
    />
  );
}
