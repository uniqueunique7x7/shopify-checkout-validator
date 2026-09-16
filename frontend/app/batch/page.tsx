import { redirect } from "next/navigation";

/** The combined workspace moved to /bulk-checker; keep old links working. */
export default async function LegacyBatchRedirect({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job } = await searchParams;
  redirect(job ? `/bulk-checker?job=${job}` : "/bulk-checker");
}
