"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoTip } from "@/components/ui/tooltip";

export interface RunSettings {
  concurrency: number;
  retries: number;
  maxPrice: string;
  proxy: string;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  concurrency: 3,
  retries: 1,
  maxPrice: "",
  proxy: "",
};

const WORKER_OPTIONS = [1, 2, 3, 5, 8, 12, 20, 30, 50];
const RETRY_OPTIONS = [1, 2, 3, 4, 5];

/**
 * The execution controls shared by both validator forms. Deliberately excludes
 * the endpoint choice: a site scan and a card scan always use different flows.
 */
export function RunSettingsFields({
  value,
  onChange,
  defaultMaxPrice,
}: {
  value: RunSettings;
  onChange: (patch: Partial<RunSettings>) => void;
  defaultMaxPrice?: number;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1.5">
        <Label htmlFor="run-workers">
          Workers
          <InfoTip>
            Parallel tasks inside the job. Each store also has its own server-side request
            semaphore (concurrency per store).
          </InfoTip>
        </Label>
        <Select value={String(value.concurrency)} onValueChange={(v) => onChange({ concurrency: Number(v) })}>
          <SelectTrigger id="run-workers">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKER_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} {n === 1 ? "worker" : "workers"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="run-retries">
          Retries
          <InfoTip>Attempts per task. Only error-classified results are retried.</InfoTip>
        </Label>
        <Select value={String(value.retries)} onValueChange={(v) => onChange({ retries: Number(v) })}>
          <SelectTrigger id="run-retries">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETRY_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="run-price" hint={`default ${defaultMaxPrice ?? "—"}`}>
          Max price
        </Label>
        <Input
          id="run-price"
          type="number"
          min={1}
          value={value.maxPrice}
          onChange={(e) => onChange({ maxPrice: e.target.value })}
          placeholder={defaultMaxPrice ? String(defaultMaxPrice) : "500"}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="run-proxy" hint="optional">
          Proxy
        </Label>
        <Input
          id="run-proxy"
          value={value.proxy}
          onChange={(e) => onChange({ proxy: e.target.value })}
          placeholder="host:port:user:pass"
          className="font-mono"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
