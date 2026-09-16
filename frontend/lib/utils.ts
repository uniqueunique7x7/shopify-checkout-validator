import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatClock(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return `${Math.max(1, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

export function maskCard(card: string): string {
  if (!card) return "";
  const [pan, mm, yy] = card.split("|");
  if (!pan) return card;
  const masked = pan.length > 10 ? `${pan.slice(0, 6)}${"*".repeat(pan.length - 10)}${pan.slice(-4)}` : pan;
  return [masked, mm, yy, "***"].filter(Boolean).join("|");
}

export function normalizeSiteInput(raw: string): string {
  let value = raw.trim().replace(/^,+|,+$/g, "");
  if (!value) return "";
  value = value.split("|")[0].trim();
  const match = value.match(/(https?:\/\/[^\s]+)|([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  if (!match) return "";
  let url = match[0];
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function cleanSiteList(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const site = normalizeSiteInput(line);
    if (site && !seen.has(site)) {
      seen.add(site);
      out.push(site);
    }
  }
  return out.join("\n");
}

const CARD_RE = /(\d{13,19})\s*[\s|/:]\s*(\d{1,2})\s*[\s|/:]\s*(\d{2,4})\s*[\s|/:]\s*(\d{3,4})/;

export function normalizeCardInput(raw: string): string {
  const match = raw.match(CARD_RE);
  if (!match) return "";
  const [, pan, mm, year, cvv] = match;
  const yy = year.length === 4 ? year.slice(2) : year;
  return `${pan}|${mm.padStart(2, "0")}|${yy}|${cvv}`;
}

export function cleanCardList(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const card = normalizeCardInput(line);
    if (card && !seen.has(card)) {
      seen.add(card);
      out.push(card);
    }
  }
  return out.join("\n");
}

export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function downloadText(filename: string, text: string, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const BUCKET_LABEL: Record<string, string> = {
  live: "Live",
  die: "Die",
  error: "Error",
};

/**
 * A card scan judges the card, not the store, so the same three buckets read
 * differently there: an expired card is a *declined* card, while an expired
 * card in a site scan still proves the store is *live*.
 */
export const CARD_BUCKET_LABEL: Record<string, string> = {
  live: "Success",
  die: "Declined",
  error: "Error",
};

/** Result labels for a job mode (`card` differs from everything else). */
export function bucketLabels(mode?: string | null): Record<string, string> {
  return mode === "card" ? CARD_BUCKET_LABEL : BUCKET_LABEL;
}

export const BUCKET_CLASS: Record<string, string> = {
  live: "text-success",
  die: "text-destructive",
  error: "text-warning",
};

export const BUCKET_BADGE: Record<string, string> = {
  live: "border-success/40 bg-success/10 text-success",
  die: "border-destructive/40 bg-destructive/10 text-destructive",
  error: "border-warning/40 bg-warning/10 text-warning",
};
