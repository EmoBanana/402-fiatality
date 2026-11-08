/**
 * What went wrong and what to do next, from any thrown value (ApiError or not).
 *   <ErrorState error={sellers.error} onRetry={sellers.reload} />
 *   toast({ tone: "danger", ...describeError(err) })          // same words in a toast
 * ApiError status 0 (gateway unreachable) explains how to start it: `npm run dev`.
 */
import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

export interface DescribedError {
  title: string;
  description: ReactNode;
  /** True when the gateway could not be reached at all. */
  gatewayDown: boolean;
}

export function describeError(error: unknown, fallbackTitle = "That didn't work"): DescribedError {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return {
        title: "The gateway isn't running",
        description: (
          <>
            Start it from the repo root with <code>npm run dev</code>, then try again.
          </>
        ),
        gatewayDown: true,
      };
    }
    if (error.status === 404) return { title: "Not found", description: error.message, gatewayDown: false };
    if (error.status === 503 && error.code === "not_wired") {
      return { title: "This part of the gateway isn't ready yet", description: error.message, gatewayDown: false };
    }
    if (error.status === 401 || error.status === 403) {
      return { title: "The gateway refused this action", description: error.message, gatewayDown: false };
    }
    return { title: fallbackTitle, description: error.message, gatewayDown: false };
  }
  if (error instanceof Error) return { title: fallbackTitle, description: error.message, gatewayDown: false };
  return { title: fallbackTitle, description: "Try again in a moment.", gatewayDown: false };
}

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Overrides the derived title (the description still explains the cause). */
  title?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function ErrorState({ error, onRetry, title, compact = false, className }: ErrorStateProps) {
  const described = describeError(error, "Couldn't load this");
  return (
    <div role="alert" className={className}>
      <EmptyState
        tone={described.gatewayDown ? "default" : "danger"}
        compact={compact}
        title={title ?? described.title}
        description={described.description}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
