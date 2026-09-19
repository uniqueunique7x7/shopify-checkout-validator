import { redirect } from "next/navigation";

/** The combined workspace is gone; old deep links land on the site validator. */
export default async function LegacyBatchRedirect({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job } = await searchParams;
  redirect(job ? `/site-validator?job=${job}` : "/site-validator");
}
