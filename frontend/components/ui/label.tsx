"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { hint?: React.ReactNode }
>(({ className, children, hint, ...props }, ref) => (
  <div className="flex items-baseline justify-between gap-2">
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "text-xs font-semibold uppercase tracking-wide text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    >
      {children}
    </LabelPrimitive.Root>
    {hint ? <span className="text-[11px] text-muted-foreground/80">{hint}</span> : null}
  </div>
));
Label.displayName = "Label";

export { Label };
