import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="font-mono text-4xl font-semibold text-primary">404</p>
        <p className="text-sm font-semibold">This page does not exist</p>
        <p className="text-xs text-muted-foreground">
          Check the sidebar for the available workspaces: dashboard, site validator, card validator, jobs, stores,
          cards, history, logs and settings.
        </p>
        <Button asChild size="sm">
          <Link href="/">Back to dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
