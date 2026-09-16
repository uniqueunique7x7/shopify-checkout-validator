"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { SiteValidator } from "@/components/batch/site-validator";
import { Skeleton } from "@/components/ui/skeleton";

function SiteValidatorPage() {
  const params = useSearchParams();
  const jobId = params.get("job");

  return (
    <>
      <PageHeader
        eyebrow="Validator"
        title="Site validator"
        description="Paste a list of stores and find out which ones have a working Shopify Payments gateway. One task per store."
      />
      <SiteValidator initialJobId={jobId} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SiteValidatorPage />
    </Suspense>
  );
}
