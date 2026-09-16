"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { formatNumber } from "@/lib/utils";
import type { RuntimeSettings } from "@/types/api";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/tooltip";
import { LoadingState, ErrorState } from "@/components/ui/states";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function SettingsPage() {
  const { data, error, isLoading, mutate } = useSWR("settings", api.settings);
  const { data: config } = useSWR("config", api.config);
  const { data: cache, mutate: mutateCache } = useSWR("cache", api.cache, { refreshInterval: 15000 });

  const [draft, setDraft] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState<null | "save" | "reset" | "cache" | "history">(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmHistory, setConfirmHistory] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  const dirty =
    draft && data
      ? Object.keys(draft).some(
          (key) => draft[key as keyof RuntimeSettings] !== data[key as keyof RuntimeSettings],
        )
      : false;

  function update<K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    try {
      const updated = await api.updateSettings(draft);
      await mutate(updated, { revalidate: false });
      toast.success("Settings saved", { description: "Changes apply to new requests immediately." });
    } catch (caught) {
      reportError(caught, "Could not save settings");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const updated = await api.resetSettings();
      setDraft(updated);
      await mutate(updated, { revalidate: false });
      toast.success("Restored environment defaults");
    } catch (caught) {
      reportError(caught, "Could not reset settings");
    } finally {
      setBusy(null);
      setConfirmReset(false);
    }
  }

  async function clearCache() {
    setBusy("cache");
    try {
      const result = await api.clearCache();
      toast.success(`Cleared ${result.cleared} cached store(s)`);
      await mutateCache();
    } catch (caught) {
      reportError(caught, "Could not clear the cache");
    } finally {
      setBusy(null);
    }
  }

  async function clearHistory() {
    setBusy("history");
    try {
      const result = await api.clearHistory();
      toast.success(`Deleted ${result.deleted} history entr(ies)`);
    } catch (caught) {
      reportError(caught, "Could not clear history");
    } finally {
      setBusy(null);
      setConfirmHistory(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Runtime configuration"
        description="Values are stored in backend/data/settings.json and override the .env defaults. Nothing here is exposed to the browser except what you see."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)} loading={busy === "reset"}>
              <RotateCcw />
              Reset to .env
            </Button>
            <Button size="sm" onClick={save} loading={busy === "save"} disabled={!dirty}>
              <Save />
              Save changes
            </Button>
          </div>
        }
      />

      {error ? (
        <Card>
          <ErrorState message={(error as Error).message} onRetry={() => mutate()} />
        </Card>
      ) : isLoading || !draft ? (
        <Card>
          <LoadingState label="Loading settings…" />
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <Card>
            <CardHeader>
              <CardTitle>Engine limits</CardTitle>
              <CardDescription>Applied per request; concurrency changes take effect on the next request.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="max_price">
                  Max cart total (USD)
                  <InfoTip>
                    Checkouts whose product + shipping + tax exceed this are aborted with PRICE_OVER_MAX.
                  </InfoTip>
                </Label>
                <Input
                  id="max_price"
                  type="number"
                  min={1}
                  value={draft.max_price}
                  onChange={(event) => update("max_price", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="site_concurrency">
                  Concurrency per store
                  <InfoTip>Semaphore limiting simultaneous requests per hostname.</InfoTip>
                </Label>
                <Input
                  id="site_concurrency"
                  type="number"
                  min={1}
                  max={200}
                  value={draft.site_concurrency}
                  onChange={(event) => update("site_concurrency", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="request_timeout">Request timeout (s)</Label>
                <Input
                  id="request_timeout"
                  type="number"
                  min={5}
                  max={300}
                  value={draft.request_timeout}
                  onChange={(event) => update("request_timeout", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="connect_timeout">Connect timeout (s)</Label>
                <Input
                  id="connect_timeout"
                  type="number"
                  min={1}
                  max={120}
                  value={draft.connect_timeout}
                  onChange={(event) => update("connect_timeout", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cache_ttl">
                  Product cache TTL (s)
                  <InfoTip>How long a store&apos;s catalog is reused before it is fetched again.</InfoTip>
                </Label>
                <Input
                  id="cache_ttl"
                  type="number"
                  min={0}
                  value={draft.cache_ttl}
                  onChange={(event) => update("cache_ttl", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="default_concurrency">Default job workers</Label>
                <Input
                  id="default_concurrency"
                  type="number"
                  min={1}
                  max={50}
                  value={draft.default_concurrency}
                  onChange={(event) => update("default_concurrency", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="default_retries">Default retries</Label>
                <Input
                  id="default_retries"
                  type="number"
                  min={1}
                  max={10}
                  value={draft.default_retries}
                  onChange={(event) => update("default_retries", Number(event.target.value))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="log_level">Log level</Label>
                <Select value={draft.log_level} onValueChange={(value) => update("log_level", value as RuntimeSettings["log_level"])}>
                  <SelectTrigger id="log_level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["debug", "info", "warning", "error"] as const).map((value_) => (
                      <SelectItem key={value_} value={value_}>
                        {value_}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="history_limit">History entries kept</Label>
                <Input
                  id="history_limit"
                  type="number"
                  min={100}
                  step={100}
                  value={draft.history_limit}
                  onChange={(event) => update("history_limit", Number(event.target.value))}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3 sm:col-span-2">
                <div>
                  <p className="text-xs font-semibold">Store full card numbers in history</p>
                  <p className="text-[11px] text-muted-foreground">
                    Off by default — history keeps masked PANs only. Turning this on writes full card data to
                    <span className="font-mono"> data/history.json</span>.
                  </p>
                </div>
                <Switch
                  checked={draft.history_store_full_cards}
                  onCheckedChange={(checked) => update("history_store_full_cards", checked)}
                />
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Server</CardTitle>
                <CardDescription>Read-only values from the environment</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {config ? (
                  <>
                    <Row label="Version" value={config.version} />
                    <Row label="Connection pool" value={`${config.limits.pool_size} total / ${config.limits.pool_per_host} per host`} />
                    <Row label="Max workers" value={String(config.limits.max_concurrency)} />
                    <Row label="Max sites per job" value={formatNumber(config.limits.max_batch_tasks)} />
                    <Row label="CORS" value={config.limits.cors_origins.join(", ")} />
                    <Row label="Cards file" value={String(config.env.cards_file ?? "—")} mono />
                    <Row label="Requests log" value={String(config.env.log_file ?? "—")} mono />
                    <Row label="History file" value={String(config.env.history_file ?? "—")} mono />
                  </>
                ) : (
                  <LoadingState label="Loading…" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Response vocabulary</CardTitle>
                <CardDescription>Codes the classifier recognises</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Live</p>
                  <div className="flex flex-wrap gap-1">
                    {config?.responses.live.map((code) => (
                      <Badge key={code} variant="success" className="font-mono">
                        {code}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Operational errors
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {config?.responses.error.map((code) => (
                      <Badge key={code} variant="warning" className="font-mono">
                        {code}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <div>
                  <CardTitle>Product cache</CardTitle>
                  <CardDescription>
                    {formatNumber(cache?.count ?? 0)} store(s) · TTL {cache?.ttl ?? 0}s
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={clearCache} loading={busy === "cache"}>
                  <Trash2 />
                  Clear
                </Button>
              </CardHeader>
              <CardContent>
                {!cache ? (
                  <LoadingState label="Loading cache…" />
                ) : cache.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Cache is empty.</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Host</TableHead>
                          <TableHead className="text-right">Cap</TableHead>
                          <TableHead className="text-right">Variants</TableHead>
                          <TableHead className="text-right">Age</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cache.items.map((entry) => (
                          <TableRow key={`${entry.host}-${entry.max_price}`}>
                            <TableCell className="max-w-[160px] truncate font-mono text-[11px]">
                              {entry.host}
                            </TableCell>
                            <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                              {entry.max_price ? `$${entry.max_price}` : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-[11px]">{entry.candidates}</TableCell>
                            <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                              {Math.round(entry.age_seconds)}s
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-destructive/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-destructive">Danger zone</CardTitle>
                <CardDescription>Irreversible local data removal</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="destructive" size="sm" onClick={() => setConfirmHistory(true)}>
                  <Trash2 />
                  Delete execution history
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <ConfirmationDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset runtime settings?"
        description="All overrides are discarded and the values from .env (or the built-in defaults) are restored."
        confirmLabel="Reset"
        onConfirm={reset}
      />

      <ConfirmationDialog
        open={confirmHistory}
        onOpenChange={setConfirmHistory}
        title="Delete execution history?"
        description="Every stored record is removed from data/history.json. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={clearHistory}
      />
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`max-w-[62%] break-all text-right ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}
