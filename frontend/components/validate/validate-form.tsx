"use client";

import { useState } from "react";
import useSWR from "swr";
import { motion } from "framer-motion";
import { BadgeCheck, CreditCard, Loader2, Play, RotateCcw, ShieldQuestion, Store } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { cn, cleanCardList } from "@/lib/utils";
import type { CheckResult, RawResult } from "@/types/api";

import { Badge } from "@/components/ui/badge";
import { BucketBadge, ResponseBadge } from "@/components/ui/bucket-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/states";

const STEPS = [
  "Resolving product",
  "Adding to cart",
  "Opening checkout session",
  "Negotiating shipping proposal",
  "Negotiating delivery proposal",
  "Tokenizing card",
  "Submitting for completion",
  "Polling receipt",
];

export function ValidateForm({ initialSite = "" }: { initialSite?: string }) {
  const { data: settings } = useSWR("settings", api.settings);
  const [site, setSite] = useState(initialSite);
  const [card, setCard] = useState("");
  const [proxy, setProxy] = useState("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [variantId, setVariantId] = useState("");
  const [mode, setMode] = useState<"check" | "full">("full");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RawResult | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [step, setStep] = useState(0);
  const [variants, setVariants] = useState<{ variant_id: string; title: string; price: string }[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!site.trim()) {
      toast.error("Enter a store URL");
      return;
    }

    setRunning(true);
    setResult(null);
    setCheck(null);
    setStep(0);

    const ticker = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 1100);

    try {
      const payload = {
        site: site.trim(),
        card: card.trim() || undefined,
        proxy: proxy.trim() || undefined,
        max_price: maxPrice ? Number(maxPrice) : undefined,
      };

      if (mode === "check") {
        const data = await api.check(payload);
        setCheck(data);
        setResult(data.raw);
        toast[data.bucket === "live" ? "success" : data.bucket === "die" ? "warning" : "error"](
          `Store responded: ${data.card_response}`,
          { description: data.valid ? "Gateway is live." : "No live gateway evidence." },
        );
      } else {
        const data = await api.validate({ ...payload, variant_id: variantId.trim() || undefined });
        setResult(data);
        toast[data.bucket === "live" ? "success" : data.bucket === "die" ? "warning" : "error"](
          data.Response,
          { description: data.Product ? `${data.Product} · $${data.Price}` : undefined },
        );
      }
    } catch (error) {
      reportError(error, "Validation failed");
    } finally {
      clearInterval(ticker);
      setRunning(false);
    }
  }

  async function loadVariants() {
    if (!site.trim()) {
      toast.error("Enter a store URL first");
      return;
    }
    setLoadingVariants(true);
    try {
      const data = await api.products(site.trim(), maxPrice ? Number(maxPrice) : undefined, true, 60);
      setVariants(data.candidates.map(({ variant_id, title, price }) => ({ variant_id, title, price })));
      if (!data.candidates.length) {
        toast.info("No variants found", { description: data.error ?? "Nothing under the price cap." });
      } else {
        toast.success(`${data.candidates.length} variant(s) available`);
      }
    } catch (error) {
      reportError(error, "Could not load variants");
    } finally {
      setLoadingVariants(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <Card>
        <CardHeader>
          <CardTitle>Run a single check</CardTitle>
          <CardDescription>
            The full flow adds the cheapest variant to the cart, opens a checkout session, negotiates shipping and
            delivery, tokenizes the card and submits for completion.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="site" hint="hostname or full URL">
                  Store
                </Label>
                <Input
                  id="site"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  placeholder="store.myshopify.com"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="card" hint="leave empty to use cards.txt">
                  Card
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="card"
                    value={card}
                    onChange={(e) => setCard(e.target.value)}
                    placeholder="4111111111111111|12|30|123"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCard(cleanCardList(card) || card)}
                    title="Normalize separators"
                  >
                    Normalize
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Accepts <span className="font-mono">cc|mm|yy|cvv</span> or{" "}
                  <span className="font-mono">cc|mm|yyyy|cvv</span>. Without a card the engine picks a random one from
                  the cards file.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="max-price" hint={`default ${settings?.max_price ?? "—"}`}>
                  Max price (USD)
                </Label>
                <Input
                  id="max-price"
                  type="number"
                  min={1}
                  step="1"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder={settings ? String(settings.max_price) : "500"}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mode">Flow</Label>
                <Select value={mode} onValueChange={(value) => setMode(value as "check" | "full")}>
                  <SelectTrigger id="mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full checkout submission</SelectItem>
                    <SelectItem value="check">Gateway probe (stop at payment step)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="proxy" hint="host:port:user:pass">
                  Proxy
                </Label>
                <Input
                  id="proxy"
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="203.0.113.10:8080:user:pass"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="variant" hint="optional">
                  Pin a variant ID
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="variant"
                    value={variantId}
                    onChange={(e) => setVariantId(e.target.value)}
                    placeholder="42436493115472"
                    className="font-mono"
                    autoComplete="off"
                  />
                  <Button type="button" variant="outline" onClick={loadVariants} loading={loadingVariants}>
                    {!loadingVariants ? <Store /> : null}
                    Load variants
                  </Button>
                </div>
                {variants.length > 0 ? (
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {variants.slice(0, 40).map((variant) => (
                      <button
                        key={variant.variant_id}
                        type="button"
                        onClick={() => setVariantId(variant.variant_id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-xs hover:bg-accent",
                          variantId === variant.variant_id && "bg-accent",
                        )}
                      >
                        <span className="truncate">{variant.title}</span>
                        <span className="shrink-0 font-mono text-muted-foreground">${variant.price}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" loading={running}>
                {!running ? <Play /> : null}
                {mode === "check" ? "Probe store" : "Validate checkout"}
              </Button>
              <Button
                type="reset"
                variant="ghost"
                onClick={() => {
                  setResult(null);
                  setCheck(null);
                  setVariants([]);
                }}
              >
                <RotateCcw />
                Reset result
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Runs server-side through the configured proxy (never in the browser).
              </span>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {running ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Working…
              </CardTitle>
              <CardDescription>The engine is walking through the checkout pipeline.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {STEPS.map((label, index) => (
                <div
                  key={label}
                  className={cn(
                    "flex items-center gap-2 text-xs transition-colors",
                    index === step ? "text-foreground" : index < step ? "text-muted-foreground" : "text-muted-foreground/50",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      index === step ? "bg-primary" : index < step ? "bg-success" : "bg-border",
                    )}
                  />
                  {label}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {result ? <ResultPanel result={result} check={check} /> : null}

        {!result && !running ? (
          <Card>
            <CardContent className="pt-4">
              <EmptyState
                icon={ShieldQuestion}
                title="No result yet"
                description="Submit a store to see the response code, detected gateway, product and price."
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ResultPanel({ result, check }: { result: RawResult; check: CheckResult | null }) {
  const rows: { label: string; value: React.ReactNode; tip?: string }[] = [
    { label: "Response", value: <ResponseBadge response={result.Response} bucket={result.bucket} /> },
    { label: "Verdict", value: <BucketBadge bucket={result.bucket} /> },
    { label: "Gateway", value: result.Gate || "—" },
    { label: "Product", value: result.Product || "—" },
    { label: "Price", value: `$${result.Price}` },
    { label: "Card", value: <span className="font-mono">{result.CCMasked}</span> },
    { label: "Charged", value: result.charged ? "Yes" : "No" },
    { label: "Approved", value: result.approved ? "Yes" : "No" },
    {
      label: "Gateway live",
      value: result.gateway_live ? "Yes" : "No",
      tip: "True when the response code is in the original LIVE_RESPONSES set.",
    },
    { label: "Duration", value: result.Time },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {result.bucket === "live" ? (
              <BadgeCheck className="h-4 w-4 text-success" />
            ) : (
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            )}
            Result
          </CardTitle>
          <Badge variant="outline">{result.ElapsedMs} ms</Badge>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-start justify-between gap-4 border-b border-border/60 pb-1.5 text-xs last:border-0">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {row.label}
                {row.tip ? <InfoTip>{row.tip}</InfoTip> : null}
              </span>
              <span className="max-w-[60%] truncate text-right font-medium">{row.value}</span>
            </div>
          ))}
          {result.Detail ? (
            <p className="mt-2 rounded-md border border-warning/30 bg-warning/5 p-2 font-mono text-[11px] text-warning">
              {result.Detail}
            </p>
          ) : null}
          {check ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Probe summary: valid=<span className="font-mono">{String(check.valid)}</span> · bucket=
              <span className="font-mono">{check.bucket}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  );
}
