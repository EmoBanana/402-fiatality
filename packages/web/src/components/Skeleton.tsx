/**
 * Loading placeholders shaped like the content they stand in for (calm pulse, no shimmer).
 *   <Skeleton width={120} height={28} />     <SkeletonText lines={3} />
 * Wrap a loading region in aria-busy="true" so assistive tech knows it is coming.
 */
import type { CSSProperties } from "react";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 14, radius, className, style }: SkeletonProps) {
  return (
    <span
      className={["ui-skeleton", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={["ui-skeleton-lines", className].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
    </span>
  );
}
