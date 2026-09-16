"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";

import { cleanSiteList, splitLines } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatStrip, StatTile } from "@/components/batch/stat-tile";
import { Badge } from "@/components/ui/badge";
import { LoadFileButton } from "@/components/ui/load-file-button";

/**
 * Step 1 of a site scan: paste the stores to test. Cards are optional — when
 * omitted the engine picks one from cards.txt for every store.
 */
export function SiteInput({
  sites,
  onSitesChange,
  card,
  onCardChange,
  availableCards,
  onLoadFromFile,
}: {
  sites: string;
  onSitesChange: (value: string) => void;
  card: string;
  onCardChange: (value: string) => void;
  availableCards: number;
  onLoadFromFile: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const siteLines = splitLines(sites);

  function handleClean() {
    const before = siteLines.length;
    const cleaned = cleanSiteList(sites);
    const after = splitLines(cleaned).length;
    onSitesChange(cleaned);
    if (!before) return;
    toast.success(`Kept ${after} of ${before} line(s)`, {
      description:
        after < before ? `${before - after} dropped as invalid or duplicate.` : "Nothing needed changing.",
    });
  }

  /** Shared by the drop zone and the file picker so both behave identically. */
  function applySiteFile(text: string, fileName: string) {
    const cleaned = cleanSiteList(text);
    const count = splitLines(cleaned).length;
    if (!count) {
      toast.error(`${fileName} had no usable store lines`);
      return;
    }
    onSitesChange(cleaned);
    toast.success(`Loaded ${count} store(s) from ${fileName}`);
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    applySiteFile(await file.text(), file.name);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="site-list" hint={`${siteLines.length} store(s)`}>
          Stores to test
        </Label>
        <Textarea
          id="site-list"
          value={sites}
          onChange={(e) => onSitesChange(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          placeholder={"store-a.myshopify.com\nhttps://store-b.com\nbrand.com|extra|columns"}
          className={`h-[280px] mono-input transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleClean} disabled={!sites.trim()}>
            <Wand2 />
            Clean URLs
          </Button>
          <LoadFileButton
            onLoad={applySiteFile}
            label="Load stores from file"
            title="Load a .txt file of stores from disk"
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => onSitesChange("")} disabled={!sites.trim()}>
            Clear
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Drop a <span className="font-mono">.txt</span> file here, or paste one store per line.
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="site-card" hint="optional — blank uses cards.txt">
          Card
        </Label>
        <div className="flex gap-2">
          <Textarea
            id="site-card"
            value={card}
            onChange={(e) => onCardChange(e.target.value)}
            placeholder="4111111111111111|12|30|123"
            className="h-[72px] mono-input"
            spellCheck={false}
          />
          <div className="flex shrink-0 flex-col gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onLoadFromFile}>
              Use cards.txt
            </Button>
            <Badge variant="secondary" className="justify-center">
              {availableCards} available
            </Badge>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Leave this empty to let the engine take a card from{" "}
          <span className="font-mono">cards.txt</span> for each store. A store is reported{" "}
          <span className="text-success">live</span> when its gateway answers the card at all.
        </p>
      </div>

      <StatStrip>
        <StatTile label="Stores" value={siteLines.length} tone="primary" />
        <StatTile label="Tasks" value={siteLines.length} />
        <StatTile label="Card mode" value={card.trim() ? "pinned" : "random"} />
        <StatTile label="Flow" value={<span className="text-[13px]">probe</span>} />
      </StatStrip>
    </div>
  );
}
