"use client";

import { useState } from "react";
import { Wand2, Shuffle } from "lucide-react";
import { toast } from "sonner";

import { cleanCardList, splitLines } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatStrip, StatTile } from "@/components/batch/stat-tile";
import { LoadFileButton } from "@/components/ui/load-file-button";

const CARD_RE = /^\d{13,19}\|\d{1,2}\|\d{2,4}\|\d{3,4}$/;

/**
 * Step 1 of a card scan: the cards to test, and where they run.
 *
 * The target is normally a single store, so its gateway is exercised
 * repeatedly. In random-target mode the store field is replaced by a pool
 * explainer and the backend deals each card its own live store instead.
 */
export function CardInput({
  site,
  onSiteChange,
  cards,
  onCardsChange,
  availableCards,
  onLoadFromFile,
  randomTarget = false,
  poolCount = 0,
}: {
  site: string;
  onSiteChange: (value: string) => void;
  cards: string;
  onCardsChange: (value: string) => void;
  availableCards: number;
  onLoadFromFile: () => void;
  /** Deal every card its own store from the live pool instead of one fixed store. */
  randomTarget?: boolean;
  /** Size of the live pool, shown when random targeting is on. */
  poolCount?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const lines = splitLines(cards);
  const invalid = lines.filter((line) => !CARD_RE.test(line.replace(/\s/g, "")));
  const valid = lines.length - invalid.length;

  function handleClean() {
    const before = lines.length;
    const cleaned = cleanCardList(cards);
    const after = splitLines(cleaned).length;
    onCardsChange(cleaned);
    if (!before) return;
    toast.success(`Kept ${after} of ${before} card(s)`, {
      description: after < before ? `${before - after} dropped as invalid or duplicate.` : "Nothing needed changing.",
    });
  }

  /** Shared by the drop zone and the file picker so both behave identically. */
  function applyCardFile(text: string, fileName: string) {
    const cleaned = cleanCardList(text);
    const count = splitLines(cleaned).length;
    if (!count) {
      toast.error(`${fileName} had no usable card lines`);
      return;
    }
    onCardsChange(cleaned);
    toast.success(`Loaded ${count} card(s) from ${fileName}`);
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    applyCardFile(await file.text(), file.name);
  }

  return (
    <div className="space-y-3">
      {randomTarget ? (
        <div className="space-y-1.5">
          <Label hint="no single store — the pool decides">Target store</Label>
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
            <Shuffle className="h-3.5 w-3.5 shrink-0 text-primary" />
            <p className="text-xs">
              Each card gets its own store, dealt at random from all{" "}
              <span className="font-mono text-foreground">{poolCount}</span> live site(s). Nothing repeats
              until the pool is used up.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="card-site" hint="the store every card is tested against">
            Target store
          </Label>
          <div className="flex gap-2">
            <Input
              id="card-site"
              value={site}
              onChange={(e) => onSiteChange(e.target.value)}
              placeholder="Pick from the live pool above, or type a store"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const cleaned = site
                  .split("\n")
                  .map((s) => s.trim())
                  .find(Boolean);
                onSiteChange(cleaned ?? "");
              }}
              disabled={!site.includes("\n")}
              title="Keep the first line"
            >
              First line
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Pick one of the live sites above, or type any store. Use{" "}
            <span className="font-mono">/stores</span> to confirm it has a Shopify Payments gateway first.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="card-list" hint={`${valid} valid${invalid.length ? ` · ${invalid.length} invalid` : ""}`}>
          Cards to test
        </Label>
        <Textarea
          id="card-list"
          value={cards}
          onChange={(e) => onCardsChange(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          placeholder={"4111111111111111|12|30|123\n5424180011223344|05|2027|999"}
          className={`h-[280px] mono-input transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleClean} disabled={!cards.trim()}>
            <Wand2 />
            Clean cards
          </Button>
          <LoadFileButton
            onLoad={applyCardFile}
            label="Load cards from file"
            title="Load a .txt file of cards from disk"
          />
          <Button type="button" variant="outline" size="sm" onClick={onLoadFromFile} title="Load the cards stored on the server">
            From cards.txt
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onCardsChange("")} disabled={!cards.trim()}>
            Clear
          </Button>
          <Badge variant="secondary">{availableCards} in file</Badge>
        </div>
        {invalid.length > 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning/5 p-2 font-mono text-[11px] text-warning">
            {invalid.length} line(s) will be rejected: {invalid.slice(0, 3).join(", ")}
            {invalid.length > 3 ? ` … +${invalid.length - 3}` : ""}
          </p>
        ) : null}
      </div>

      <StatStrip>
        <StatTile label="Cards" value={valid} tone="primary" />
        <StatTile label="Tasks" value={valid} />
        <StatTile label="Targets" value={1} />
        <StatTile label="Flow" value={<span className="text-[13px]">probe</span>} />
      </StatStrip>
    </div>
  );
}
