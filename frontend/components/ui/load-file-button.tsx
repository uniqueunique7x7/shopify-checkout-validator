"use client";

import { useRef } from "react";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * "Load file" button backed by a hidden `<input type="file">`.
 *
 * Reads the picked text file and hands the raw contents to `onLoad`, so callers
 * can run their own cleaner (stores, cards, …) over it. Complements the
 * drag-and-drop that the input panels already support.
 */
export function LoadFileButton({
  onLoad,
  label = "Load file",
  accept = ".txt,text/plain",
  variant = "outline",
  size = "sm",
  disabled,
  title,
}: {
  onLoad: (text: string, fileName: string) => void;
  label?: string;
  accept?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // clear the value so picking the same file twice in a row still fires
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      onLoad(text, file.name);
    } catch {
      toast.error(`Could not read ${file.name}`);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handlePick}
        tabIndex={-1}
        aria-hidden="true"
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        title={title}
        onClick={() => inputRef.current?.click()}
      >
        <FolderOpen />
        {label}
      </Button>
    </>
  );
}
