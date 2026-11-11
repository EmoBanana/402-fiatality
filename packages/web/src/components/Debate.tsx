/**
 * The AI jury's debate as a court record: prosecutor, defender, judge, in the order they spoke. While the
 * hearing runs, the next speaker shows "Thinking…". Used by the console's review banner and the jury page.
 *   <Debate messages={review.transcript} running={review.status === "running"} roles={SPEND_REVIEW_ROLES} />
 * `roles` names each side's stance, which differs between a spend review and a PayPal dispute.
 */
import type { ReviewMessageDTO, ReviewRole } from "@p402/shared";
import { formatTime } from "../lib/format";
import { Spinner } from "./Spinner";

export interface DebateRole {
  role: ReviewRole;
  label: string;
  stance: string;
}

/** A paused tab's spend review: is the spending waste? */
export const SPEND_REVIEW_ROLES: DebateRole[] = [
  { role: "prosecutor", label: "Prosecutor", stance: "argues it's waste" },
  { role: "defender", label: "Defender", stance: "argues it's legitimate" },
  { role: "judge", label: "Judge", stance: "decides" },
];

/** A PayPal dispute on a tab's charge: does the charge stand? */
export const DISPUTE_ROLES: DebateRole[] = [
  { role: "prosecutor", label: "Prosecutor", stance: "argues the buyer's claim" },
  { role: "defender", label: "Defender", stance: "argues the charge stands" },
  { role: "judge", label: "Judge", stance: "recommends" },
];

/** The judge may answer with its structured JSON; show the reason rather than raw braces. */
export function readableMessage(message: ReviewMessageDTO): string {
  const text = message.content.trim();
  if (message.role !== "judge" || !text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text) as { verdict?: string; recommendation?: string; reason?: string };
    const call = parsed.verdict ?? parsed.recommendation;
    return [call ? `${call.charAt(0).toUpperCase()}${call.slice(1).replace(/_/g, " ")}.` : "", parsed.reason ?? ""].filter(Boolean).join(" ") || text;
  } catch {
    return text;
  }
}

export interface DebateProps {
  messages: ReviewMessageDTO[];
  /** The hearing is still running: show who speaks next. */
  running?: boolean;
  roles?: DebateRole[];
  className?: string;
}

export function Debate({ messages, running = false, roles = SPEND_REVIEW_ROLES, className }: DebateProps) {
  const byRole = new Map(roles.map((r) => [r.role, r]));
  const spoken = new Set(messages.map((m) => m.role));
  const next = running ? roles.find((r) => !spoken.has(r.role)) : undefined;
  return (
    <ol className={["ui-debate", className].filter(Boolean).join(" ")}>
      {messages.map((message, i) => {
        const role = byRole.get(message.role);
        return (
          <li key={`${message.role}-${message.at}-${i}`} data-role={message.role}>
            <p className="ui-debate-role">
              {role?.label ?? message.role}
              {role ? <span>{role.stance}</span> : null}
            </p>
            <div className="ui-debate-text">
              <p>{readableMessage(message)}</p>
              <time className="muted" dateTime={new Date(message.at).toISOString()}>
                {formatTime(message.at)}
              </time>
            </div>
          </li>
        );
      })}
      {next ? (
        <li data-role={next.role}>
          <p className="ui-debate-role">
            {next.label}
            <span>{next.stance}</span>
          </p>
          <p className="ui-debate-text ui-debate-pending">
            <Spinner size={12} label={`${next.label} is thinking`} /> Thinking…
          </p>
        </li>
      ) : null}
    </ol>
  );
}
