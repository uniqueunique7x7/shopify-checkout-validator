"use client";

import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-[15.5rem] shrink-0 border-r border-border bg-card/30 lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <motion.main
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="flex-1 px-3 py-4 sm:px-4 lg:px-6 lg:py-6"
        >
          {children}
        </motion.main>
        <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground lg:px-6">
          Shopify Validator v4 · FastAPI engine ported from <span className="font-mono">main.py</span> · local tool, keep
          the backend bound to localhost.
        </footer>
      </div>
    </div>
  );
}
