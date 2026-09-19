"use client";

import { splitLines } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatStrip, StatTile } from "@/components/batch/stat-tile";
import { Badge } from "@/components/ui/badge";
import { SiteListField } from "@/components/batch/site-list-field";

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
  const siteLines = splitLines(sites);

  return (
    <div className="space-y-3">
      <SiteListField
        id="site-list"
        label="Stores to test"
        value={sites}
        onChange={onSitesChange}
        placeholder={"store-a.myshopify.com\nhttps://store-b.com\nbrand.com|extra|columns"}
        hintText={
          <>
            Drop a <span className="font-mono">.txt</span> file here, or paste one store per line.
          </>
        }
      />

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
