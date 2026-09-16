"use client";

import { toast } from "sonner";

import { ApiError } from "@/types/api";

/**
 * Turns any thrown value into a user-facing toast.
 * Returns the ApiError so callers can inspect the code if needed.
 */
export function reportError(error: unknown, fallbackTitle = "Request failed"): ApiError | Error {
  const apiError =
    error instanceof ApiError
      ? error
      : new Error(error instanceof Error ? error.message : "Unexpected error");

  toast.error(fallbackTitle, {
    description: apiError.message,
  });
  return apiError;
}
