"use client";

import { useState } from "react";
import useSWR from "swr";
import { Pause, Play, RefreshCcw, Terminal } from "lucide-react";

import { api } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LogPanel, type LogLine } from "@/components/batch/log-panel";
import { LoadingState } from "@/components/ui/states";
import { CopyButton } from "@/components/ui/copy-button";

const LEVELS = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warn" },
  { value: "error", label: "Error" },
] as const;

export default function LogsPage() {
  const [level, setLevel] = useState<string>("all");
  const [pin, setPin] = useState(true);

  const { data, isLoading, mutate, isValidating } = useSWR(
    ["logs", level],
    () => api.logs(400, level === "all" ? undefined : level),
    { refreshInterval: pin ? 3000 : 0 },
  );

  const { data: requestLog, isLoading: loadingRequests } = useSWR(
    "requests-log",
    () => api.requestsLog(400),
    { refreshInterval: pin ? 5000 : 0 },
  );

  const lines: LogLine[] = (data?.items ?? []).map((entry) => ({
    ts: entry.ts,
    level: entry.level.toLowerCase(),
    message: `${entry.logger}: ${entry.message}`,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Observability"
        title="Server logs"
        description="In-memory structured log ring buffer plus the raw requests.txt trace of every outgoing HTTP call the engine makes."
        actions={
          <div className="flex gap-2">
            <Button
              variant={pin ? "default" : "outline"}
              size="sm"
              onClick={() => setPin((value) => !value)}
            >
              {pin ? <Pause /> : <Play />}
              {pin ? "Auto-refresh on" : "Auto-refresh off"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => mutate()} loading={isValidating}>
              <RefreshCcw />
              Refresh
            </Button>
          </div>
        }
      />

      <Tabs defaultValue="app" className="space-y-3">
        <TabsList>
          <TabsTrigger value="app">
            <Terminal className="h-3.5 w-3.5" />
            Application log
          </TabsTrigger>
          <TabsTrigger value="requests">requests.txt</TabsTrigger>
        </TabsList>

        <TabsContent value="app" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {LEVELS.map((item) => (
              <Button
                key={item.value}
                variant={level === item.value ? "default" : "outline"}
                size="sm"
                onClick={() => setLevel(item.value)}
              >
                {item.label}
              </Button>
            ))}
            <Badge variant="secondary" className="ml-auto">
              {formatNumber(data?.items.length ?? 0)} record(s)
            </Badge>
            <CopyButton
              value={() => lines.map((line) => `[${line.level}] ${line.message}`).join("\n")}
              label="Copy log"
              successMessage="Log copied"
            />
          </div>

          {isLoading ? (
            <Card>
              <LoadingState label="Loading records…" />
            </Card>
          ) : (
            <LogPanel
              lines={lines}
              title="Ring buffer"
              height="h-[calc(100vh-19rem)] min-h-[320px]"
              follow={pin}
              emptyLabel="The server has not logged anything at this level yet."
            />
          )}
        </TabsContent>

        <TabsContent value="requests">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>Outgoing request trace</CardTitle>
                <CardDescription>
                  Every cart, checkout, proposal, vault and poll call with status, timing and bodies (truncated).
                </CardDescription>
              </div>
              <CopyButton value={() => requestLog ?? ""} label="Copy file" />
            </CardHeader>
            <CardContent>
              {loadingRequests ? (
                <LoadingState label="Reading requests.txt…" />
              ) : (
                <LogPanel
                  lines={
                    requestLog
                      ? requestLog
                          .split("\n")
                          .filter((line) => line.trim().length > 0)
                          .map((line) => ({
                            ts: Date.now() / 1000,
                            level: line.includes("EXCEPTION") || line.includes("Status   : 0")
                              ? "error"
                              : line.startsWith("[" + new Date().getFullYear())
                                ? "info"
                                : "debug",
                            message: line,
                          }))
                      : []
                  }
                  title="requests.txt (tail)"
                  height="h-[calc(100vh-21rem)] min-h-[320px]"
                  follow={pin}
                  emptyLabel="No outgoing requests recorded yet — run a check first."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className={cn("mt-3 text-[11px] text-muted-foreground")}>
        Log records never include card PANs or CVVs; request bodies in <span className="font-mono">requests.txt</span> do
        contain the card sent to the vault, so treat that file as sensitive.
      </p>
    </>
  );
}
