"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";

import { cleanSiteList, splitLines } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadFileButton } from "@/components/ui/load-file-button";
import { Textarea } from "@/components/ui/textarea";

/**
 * A list of stores: paste one URL per line, drop a `.txt` file on it, or load
 * one from disk.
 *
 * Owns the housekeeping every site list needs — drag-and-drop, "Clean URLs"
 * (normalise + de-duplicate) and the file picker — so the card validator, the
 * site validator and the batch form all behave identically.
 */
export function SiteListField({
  id,
  label,
  value,
  onChange,
  hint,
  hintText,
  placeholder,
  heightClassName = "h-[280px]",
  loadLabel = "Load stores from file",
  loadTitle = "Load a .txt file of stores from disk",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Overrides the default "N store(s)" label hint. */
  hint?: string;
  /** Small note rendered after the toolbar buttons. */
  hintText?: React.ReactNode;
  placeholder?: string;
  heightClassName?: string;
  loadLabel?: string;
  loadTitle?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const count = splitLines(value).length;

  function handleClean() {
    const before = count;
    const cleaned = cleanSiteList(value);
    const after = splitLines(cleaned).length;
    onChange(cleaned);
    if (!before) return;
    toast.success(`Kept ${after} of ${before} line(s)`, {
      description:
        after < before ? `${before - after} dropped as invalid or duplicate.` : "Nothing needed changing.",
    });
  }

  /** Shared by the drop zone and the file picker so both behave identically. */
  function applySiteFile(text: string, fileName: string) {
    const cleaned = cleanSiteList(text);
    const loaded = splitLines(cleaned).length;
    if (!loaded) {
      toast.error(`${fileName} had no usable store lines`);
      return;
    }
    onChange(cleaned);
    toast.success(`Loaded ${loaded} store(s) from ${fileName}`);
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    applySiteFile(await file.text(), file.name);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint ?? `${count} store(s)`}>
        {label}
      </Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        placeholder={placeholder}
        className={`${heightClassName} mono-input transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleClean} disabled={!value.trim()}>
          <Wand2 />
          Clean URLs
        </Button>
        <LoadFileButton onLoad={applySiteFile} label={loadLabel} title={loadTitle} />
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")} disabled={!value.trim()}>
          Clear
        </Button>
        {hintText ? <span className="text-[11px] text-muted-foreground">{hintText}</span> : null}
      </div>
    </div>
  );
}
