"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CardValidator } from "@/components/batch/card-validator";
import { Skeleton } from "@/components/ui/skeleton";

function CardValidatorPage() {
  const params = useSearchParams();
  const jobId = params.get("job");

  return (
    <>
      <PageHeader
        eyebrow="Validator"
        title="Card validator"
        description="Test a whole card list against one store. Every card gets its own task so the gateway is exercised repeatedly."
      />
      <CardValidator initialJobId={jobId} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <CardValidatorPage />
    </Suspense>
  );
}
