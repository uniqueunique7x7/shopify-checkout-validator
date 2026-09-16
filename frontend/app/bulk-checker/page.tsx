"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { BulkChecker } from "@/components/batch/bulk-checker";
import { Skeleton } from "@/components/ui/skeleton";

function BulkCheckerPage() {
  const params = useSearchParams();
  const jobId = params.get("job");

  return (
    <>
      <PageHeader
        eyebrow="Advanced"
        title="Bulk checker"
        description="Combined workspace: choose whether to scan stores, scan cards against one store, or pair both lists together."
      />
      <BulkChecker initialJobId={jobId} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <BulkCheckerPage />
    </Suspense>
  );
}
