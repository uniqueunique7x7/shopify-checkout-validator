"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/utils";

export function CopyButton({
  value,
  label = "Copy",
  successMessage = "Copied to clipboard",
  size = "sm",
  variant = "outline",
  className,
  disabled,
}: {
  value: string | (() => string | Promise<string>);
  label?: string;
  successMessage?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = typeof value === "function" ? await value() : value;
    if (!text) {
      toast.error("Nothing to copy yet");
      return;
    }
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error("Clipboard access was blocked by the browser");
      return;
    }
    setCopied(true);
    toast.success(successMessage);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={handleCopy}
      disabled={disabled}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      {label}
    </Button>
  );
}
