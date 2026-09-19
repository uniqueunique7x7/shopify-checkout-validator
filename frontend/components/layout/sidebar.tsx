"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  Activity,
  CreditCard,
  History,
  LayoutDashboard,
  Settings,
  Store,
  Terminal,
  Zap,
} from "lucide-react";
import useSWR from "swr";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const GROUPS: { label?: string; items: { href: string; label: string; icon: typeof Store }[] }[] = [
  {
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Validators",
    items: [
      { href: "/site-validator", label: "Site validator", icon: Store },
      { href: "/card-validator", label: "Card validator", icon: CreditCard },
    ],
  },
  {
    label: "Monitor",
    items: [
      { href: "/jobs", label: "Jobs", icon: Activity },
      { href: "/history", label: "History", icon: History },
      { href: "/logs", label: "Logs", icon: Terminal },
    ],
  },
  {
    label: "Config",
    items: [
      { href: "/cards", label: "Cards", icon: CreditCard },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data } = useSWR("health", api.health, { refreshInterval: 8000 });
  const activeJobs = (data?.jobs?.running ?? 0) + (data?.jobs?.queued ?? 0);

  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Main">
      <Link
        href="/"
        onClick={onNavigate}
        className="mb-2 flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Zap className="h-4 w-4" />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Shopify Validator</span>
          <span className="text-[11px] text-muted-foreground">Checkout suite v{data?.version ?? "4.0"}</span>
        </span>
      </Link>

      {GROUPS.map((group, index) => (
        <div key={group.label ?? `group-${index}`} className={index > 0 ? "mt-2" : undefined}>
          {group.label ? (
            <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
              {group.label}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                    active ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="sidebar-active"
                      className="absolute inset-0 rounded-md bg-accent"
                      transition={{ type: "spring", stiffness: 400, damping: 32 }}
                    />
                  ) : null}
                  <item.icon className={cn("relative h-4 w-4", active ? "text-primary" : "")} />
                  <span className="relative flex-1 truncate font-medium">{item.label}</span>
                  {item.href === "/jobs" && activeJobs > 0 ? (
                    <Badge variant="default" className="relative">
                      {activeJobs}
                    </Badge>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}

      <div className="mt-auto rounded-lg border border-border bg-card/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Reminder</p>
        <p>
          The engine only submits checkouts it can complete with the configured price cap. Every attempt is written to{" "}
          <span className="font-mono">data/requests.txt</span>.
        </p>
      </div>
    </nav>
  );
}
