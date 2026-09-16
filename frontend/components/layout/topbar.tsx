"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sidebar } from "@/components/layout/sidebar";
import { ApiStatus } from "@/components/layout/api-status";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export function Topbar() {
  const [mobileNav, setMobileNav] = useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md sm:px-4 lg:px-6">
      <Button
        variant="outline"
        size="icon-sm"
        className="lg:hidden"
        onClick={() => setMobileNav(true)}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <div className="hidden min-w-0 flex-col lg:flex">
        <span className="truncate text-sm font-semibold">Shopify Checkout Validator</span>
        <span className="truncate text-[11px] text-muted-foreground">
          Async engine · per-store concurrency · job streaming
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ApiStatus compact />
        <ApiStatus />
        <ThemeToggle />
      </div>

      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <DialogContent className="left-0 top-0 h-full max-w-[17rem] translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0 data-[state=open]:slide-in-from-left-full">
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Sidebar onNavigate={() => setMobileNav(false)} />
        </DialogContent>
      </Dialog>
    </header>
  );
}
