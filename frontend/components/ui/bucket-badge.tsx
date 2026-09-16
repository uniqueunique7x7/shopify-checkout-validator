"use client";

import { cn, bucketLabels } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { BUCKET_BADGE } from "@/lib/utils";
import type { Bucket } from "@/types/api";

const VARIANT: Record<Bucket, "success" | "destructive" | "warning"> = {
  live: "success",
  die: "destructive",
  error: "warning",
};

/** `mode` switches the wording: cards are Success/Declined, stores are Live/Die. */
export function BucketBadge({
  bucket,
  mode,
  className,
}: {
  bucket: Bucket;
  mode?: string | null;
  className?: string;
}) {
  return (
    <Badge variant={VARIANT[bucket] ?? "outline"} className={cn(className)}>
      {bucketLabels(mode)[bucket] ?? bucket}
    </Badge>
  );
}

export function ResponseBadge({ response, bucket }: { response: string; bucket?: Bucket }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        bucket ? BUCKET_BADGE[bucket] : "border-border text-muted-foreground",
      )}
    >
      {response || "UNKNOWN"}
    </span>
  );
}
