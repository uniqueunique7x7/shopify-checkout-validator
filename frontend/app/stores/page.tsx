"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Database, RefreshCcw, Search, Store } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { cleanSiteList, formatNumber, splitLines } from "@/lib/utils";
import type { ProductsResponse } from "@/types/api";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/copy-button";

export default function StoresPage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [site, setSite] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProductsResponse | null>(null);

  async function probe(target: string, refresh = false) {
    const clean = cleanSiteList(target).split("\n")[0] ?? "";
    if (!clean) {
      toast.error("Enter a valid store URL");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await api.products(clean, maxPrice ? Number(maxPrice) : undefined, refresh, 250);
      setData(result);
      if (!result.candidates.length) {
        toast.warning("No variants found", { description: result.error ?? undefined });
      } else {
        toast.success(`${result.count} variant(s) under the cap`);
      }
    } catch (caught) {
      const apiError = reportError(caught, "Could not read the catalog");
      setError(apiError.message);
    } finally {
      setLoading(false);
    }
  }

  function probeList() {
    const sites = splitLines(cleanSiteList(input));
    if (sites.length === 0) {
      toast.error("Add at least one store");
      return;
    }
    if (sites.length > 1) {
      toast.info("Probing the first store", {
        description: "Use the site validator to scan many stores at once.",
      });
    }
    setSite(sites[0]);
    void probe(sites[0]);
  }

  return (
    <>
      <PageHeader
        eyebrow="Stores"
        title="Product discovery"
        description="Inspect what the engine can buy on a store: this is the same catalog routine the checkout flow uses, including the sitemap fallback for headless Shopify."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => site && probe(site, true)}
            disabled={!site || loading}
          >
            <RefreshCcw />
            Refresh (bypass cache)
          </Button>
        }
      />

      <Card className="mb-3">
        <CardHeader>
          <CardTitle>Probe a catalog</CardTitle>
          <CardDescription>
            Cheapest in-stock variants under the price cap, read from <span className="font-mono">/products.json</span>{" "}
            (with a sitemap fallback).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="sites" hint="one per line — the first is probed">
                Stores
              </Label>
              <Textarea
                id="sites"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={"allbirds.com\nkith.com"}
                className="h-[120px] mono-input"
                spellCheck={false}
              />
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="max-price" hint="optional">
                  Max price
                </Label>
                <Input
                  id="max-price"
                  type="number"
                  min={1}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="use server default"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={probeList} loading={loading}>
                  {!loading ? <Search /> : null}
                  Probe
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setInput(cleanSiteList(input));
                    toast.success("Input cleaned");
                  }}
                >
                  Clean input
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={() => (site ? probe(site) : probeList())} />
        </Card>
      ) : loading ? (
        <Card className="p-4">
          <Skeleton className="h-32 w-full" />
        </Card>
      ) : null}

      {data ? (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
          <Card className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Store className="h-4 w-4 text-primary" />
                  <span className="truncate">{data.host}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">{data.site}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={data.cached ? "outline" : "default"}>{data.cached ? "cache hit" : "fresh fetch"}</Badge>
                <Badge variant="secondary">
                  <Database className="mr-1 h-3 w-3" />
                  {formatNumber(data.count)} variant(s) ≤ ${data.max_price}
                </Badge>
                <CopyButton value={data.candidates.map((c) => c.variant_id).join("\n")} label="Copy variant IDs" />
                <Button
                  size="sm"
                  onClick={() =>
                    router.push(
                      `/?site=${encodeURIComponent(data.site)}${maxPrice ? `&max=${maxPrice}` : ""}`,
                    )
                  }
                >
                  Validate this store
                </Button>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {data.candidates.length === 0 ? (
              <EmptyState
                icon={Store}
                title="No purchasable variants"
                description={data.error ?? "Nothing in stock under the price cap."}
              />
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border">
                      <th className="h-9 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        #
                      </th>
                      <th className="h-9 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Product
                      </th>
                      <th className="h-9 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Handle
                      </th>
                      <th className="h-9 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Variant ID
                      </th>
                      <th className="h-9 px-3 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Price
                      </th>
                      <th className="h-9 px-3 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map((candidate, index) => (
                      <tr key={candidate.variant_id} className="border-b border-border/60 hover:bg-accent/40">
                        <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{index + 1}</td>
                        <td className="max-w-[320px] truncate px-3 py-2 text-xs">{candidate.title || "—"}</td>
                        <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">
                          {candidate.handle || "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px]">{candidate.variant_id}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">${candidate.price}</td>
                        <td className="px-3 py-2 text-right">
                          <CopyButton
                            value={candidate.variant_id}
                            label=""
                            size="icon-sm"
                            variant="ghost"
                            successMessage="Variant ID copied"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </motion.div>
      ) : null}
    </>
  );
}
