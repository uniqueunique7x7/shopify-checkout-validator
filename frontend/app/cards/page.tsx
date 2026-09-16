"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { CreditCard, FileUp, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { reportError } from "@/lib/toast";
import { cleanCardList, formatNumber, splitLines } from "@/lib/utils";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function CardsPage() {
  const { data, isLoading, mutate } = useSWR("cards", api.cards, { refreshInterval: 30000 });
  const { data: bins, mutate: mutateBins } = useSWR("cards:bins", api.bins, { refreshInterval: 30000 });

  const [text, setText] = useState("");
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState<null | "save" | "upload" | "clear" | "reload">(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const lines = splitLines(text);
  const invalid = lines.filter(
    (line) => !/^\d{13,19}\|\d{1,2}\|\d{2,4}\|\d{3,4}$/.test(line.replace(/\s/g, "")),
  );

  async function save() {
    if (!lines.length) {
      toast.error("Nothing to save");
      return;
    }
    setBusy("save");
    try {
      const result = replace ? await api.saveCards(lines) : await api.appendCards(lines);
      toast.success(replace ? "Cards file replaced" : "Cards appended", {
        description: `${result.saved} stored${result.added ? ` · ${result.added} new` : ""}${
          result.invalid_count ? ` · ${result.invalid_count} rejected` : ""
        }`,
      });
      if (result.invalid_count) {
        toast.warning("Some lines were rejected", {
          description: result.invalid.slice(0, 3).join(", "),
        });
      }
      setText("");
      await Promise.all([mutate(), mutateBins()]);
    } catch (error) {
      reportError(error, "Could not write the cards file");
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy("upload");
    try {
      const result = await api.uploadCards(file);
      toast.success("File imported", {
        description: `${result.saved} card(s) stored${result.invalid_count ? ` · ${result.invalid_count} rejected` : ""}`,
      });
      await Promise.all([mutate(), mutateBins()]);
    } catch (error) {
      reportError(error, "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clear() {
    setBusy("clear");
    try {
      await api.clearCards();
      toast.success("Cards file emptied");
      await Promise.all([mutate(), mutateBins()]);
    } catch (error) {
      reportError(error, "Could not empty the file");
    } finally {
      setBusy(null);
      setConfirmClear(false);
    }
  }

  async function reload() {
    setBusy("reload");
    try {
      const snapshot = await api.reloadCards();
      toast.success(`Reloaded ${snapshot.count} card(s) from disk`);
      await mutate(snapshot, { revalidate: false });
    } catch (error) {
      reportError(error, "Could not reload");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Cards"
        title="cards.txt manager"
        description="The engine falls back to this file whenever a request or a batch row has no card. Stored on the server only — the browser never keeps card data."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reload} loading={busy === "reload"}>
              Reload from disk
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
              <Trash2 />
              Empty file
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <Card>
          <CardHeader>
            <CardTitle>Add cards</CardTitle>
            <CardDescription>
              One card per line: <span className="font-mono">cc|mm|yy|cvv</span>. Invalid lines are reported and skipped
              — the API validates every line again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cards" hint={`${lines.length} line(s)${invalid.length ? ` · ${invalid.length} invalid` : ""}`}>
                Card lines
              </Label>
              <Textarea
                id="cards"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"4111111111111111|12|30|123\n5424180011223344|05|27|999"}
                className="h-[220px] mono-input"
                spellCheck={false}
              />
            </div>

            {invalid.length > 0 ? (
              <p className="rounded-md border border-warning/30 bg-warning/5 p-2 font-mono text-[11px] text-warning">
                Will be rejected: {invalid.slice(0, 4).join(", ")}
                {invalid.length > 4 ? ` … +${invalid.length - 4} more` : ""}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch id="replace" checked={replace} onCheckedChange={setReplace} />
                <Label htmlFor="replace" className="cursor-pointer">
                  {replace ? "Replace file" : "Append to file"}
                </Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    const cleaned = cleanCardList(text);
                    setText(cleaned);
                    toast.success(`Kept ${splitLines(cleaned).length} of ${lines.length} line(s)`);
                  }}
                  disabled={!text.trim()}
                >
                  Clean input
                </Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()} loading={busy === "upload"}>
                  <FileUp />
                  Import .txt
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
                <Button onClick={save} loading={busy === "save"} disabled={!lines.length}>
                  <Save />
                  {replace ? "Replace" : "Append"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>File status</CardTitle>
              <CardDescription className="break-all font-mono">{data?.path ?? "—"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Cards loaded</span>
                <span className="font-mono text-base font-semibold">{formatNumber(data?.count ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Invalid lines seen</span>
                <span className="font-mono">{formatNumber(data?.invalid_count ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">File exists</span>
                <Badge variant={data?.exists ? "success" : "outline"}>{data?.exists ? "yes" : "no"}</Badge>
              </div>
              {data?.invalid_sample?.length ? (
                <div className="rounded-md border border-border p-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Rejected sample
                  </p>
                  <ul className="space-y-0.5 font-mono text-[11px] text-warning">
                    {data.invalid_sample.slice(0, 6).map((line) => (
                      <li key={line} className="truncate">
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>BIN distribution</CardTitle>
              <CardDescription>First six digits across the loaded cards</CardDescription>
            </CardHeader>
            <CardContent>
              {!bins ? (
                <LoadingState label="Loading BINs…" />
              ) : bins.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">No cards loaded.</p>
              ) : (
                <div className="space-y-1.5">
                  {bins.items.slice(0, 12).map((item) => {
                    const max = bins.items[0]?.count || 1;
                    return (
                      <div key={item.bin} className="flex items-center gap-2 text-xs">
                        <span className="w-16 shrink-0 font-mono">{item.bin}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(4, (item.count / max) * 100)}%` }}
                          />
                        </span>
                        <span className="w-8 shrink-0 text-right font-mono text-muted-foreground">{item.count}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-3 overflow-hidden">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Loaded cards</CardTitle>
            <CardDescription>PANs are masked by the API — CVVs are never returned</CardDescription>
          </div>
          <Badge variant="secondary">
            <CreditCard className="mr-1 h-3 w-3" />
            {formatNumber(data?.count ?? 0)}
          </Badge>
        </CardHeader>
        {isLoading ? (
          <LoadingState label="Reading cards.txt…" />
        ) : !data?.cards.length ? (
          <EmptyState
            icon={Upload}
            title="No cards loaded"
            description="Paste cards above or import a .txt file. Batch jobs without explicit cards use this file."
          />
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>BIN</TableHead>
                  <TableHead>Last 4</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>CVV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.cards.map((card, index) => (
                  <TableRow key={`${card.number}-${index}`}>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{card.number}</TableCell>
                    <TableCell className="font-mono text-xs">{card.bin}</TableCell>
                    <TableCell className="font-mono text-xs">{card.last4}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {card.month}/{card.year}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{card.cvv}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <ConfirmationDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Empty the cards file?"
        description="All stored cards are deleted from disk. Batch jobs that rely on cards.txt will fail until you add new ones."
        confirmLabel="Delete all cards"
        destructive
        onConfirm={clear}
      />
    </>
  );
}
