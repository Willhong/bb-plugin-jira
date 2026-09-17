// Small Jira-flavored visual pieces: status lozenges, issue-type glyphs,
// priority marks, and user avatars. Colors follow Jira's own conventions
// (gray / blue / green statuses; red bugs, green stories, blue tasks, purple
// epics) so issues read the way they do in Jira itself.
import type { JiraUser, StatusCategory } from "../../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(time).toLocaleDateString();
}

export function absoluteTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

const CATEGORY_CLASS: Record<StatusCategory, string> = {
  todo: "bg-muted text-muted-foreground",
  inprogress: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  done: "bg-success/15 text-success",
};

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  inprogress: "In progress",
  todo: "To do",
  done: "Done",
};

export function StatusLozenge({
  name,
  category,
  className,
}: {
  name: string;
  category: StatusCategory;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase leading-4 tracking-wide",
        CATEGORY_CLASS[category],
        className,
      )}
    >
      {name}
    </span>
  );
}

// Jira localizes type names, so each kind matches its English and Korean names.
function typeKind(type: string): "bug" | "story" | "epic" | "subtask" | "task" | "feature" | "other" {
  const name = type.toLowerCase();
  if (name.includes("bug") || name.includes("버그")) return "bug";
  if (name.includes("sub") || name.includes("하위")) return "subtask";
  if (name.includes("story") || name.includes("스토리")) return "story";
  if (name.includes("epic") || name.includes("에픽")) return "epic";
  if (name.includes("feature") || name.includes("기능")) return "feature";
  if (name.includes("task") || name.includes("작업")) return "task";
  return "other";
}

const TYPE_TONE: Record<ReturnType<typeof typeKind>, string> = {
  bug: "bg-destructive text-white",
  story: "bg-success text-white",
  epic: "bg-violet-600 text-white",
  subtask: "bg-sky-500 text-white",
  task: "bg-sky-600 text-white",
  feature: "bg-emerald-600 text-white",
  other: "bg-muted-foreground text-background",
};

export function TypeGlyph({ type, className }: { type: string; className?: string }) {
  const kind = typeKind(type);
  return (
    <span
      title={type}
      aria-label={type}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none",
        TYPE_TONE[kind],
        className,
      )}
    >
      {kind === "bug" ? (
        <Icon name="Bug" className="size-3" />
      ) : kind === "task" ? (
        <Icon name="Check" className="size-3" />
      ) : kind === "subtask" ? (
        <span className="size-1.5 rounded-[1px] border border-current" />
      ) : kind === "story" ? (
        <Icon name="Pin" className="size-2.5" />
      ) : kind === "epic" ? (
        <Icon name="Zap" className="size-2.5" />
      ) : (
        (type.trim()[0] ?? "?").toUpperCase()
      )}
    </span>
  );
}

export function PriorityMark({ priority, className }: { priority: string; className?: string }) {
  if (priority.length === 0) return null;
  const name = priority.toLowerCase();
  const [icon, tone] =
    name.includes("highest") || name.includes("blocker") || name.includes("critical")
      ? (["ChevronsUp", "text-destructive"] as const)
      : name.includes("high") || name.includes("major")
        ? (["ChevronUp", "text-destructive"] as const)
        : name.includes("lowest") || name.includes("trivial")
          ? (["ChevronsDown", "text-sky-600 dark:text-sky-400"] as const)
          : name.includes("low") || name.includes("minor")
            ? (["ChevronDown", "text-sky-600 dark:text-sky-400"] as const)
            : (["Menu", "text-warning-text"] as const);
  return (
    <span title={`Priority: ${priority}`} aria-label={`Priority ${priority}`} className={cn("inline-flex shrink-0", tone, className)}>
      {icon === "Menu" ? (
        <span className="flex h-4 w-4 flex-col items-center justify-center gap-[3px]">
          <span className="h-[2px] w-2.5 rounded bg-current" />
          <span className="h-[2px] w-2.5 rounded bg-current" />
        </span>
      ) : (
        <Icon name={icon} className="size-4" />
      )}
    </span>
  );
}

function hue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  // A Korean name is one token, family name first: show the given name.
  if (parts.length === 1 && /^[\u3131-\uD79D]{2,4}$/.test(parts[0] ?? "")) {
    return (parts[0] ?? "").slice(-2);
  }
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

export function Avatar({
  user,
  size = "sm",
  className,
}: {
  user: JiraUser | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const dimension = size === "sm" ? "size-6 text-[9px] tracking-tighter" : "size-8 text-[11px]";
  if (user === null) {
    return (
      <span
        title="Unassigned"
        aria-label="Unassigned"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground",
          dimension,
          className,
        )}
      >
        <Icon name="UserRound" className={size === "sm" ? "size-3" : "size-4"} />
      </span>
    );
  }
  return (
    <span
      title={user.displayName}
      aria-label={user.displayName}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        dimension,
        className,
      )}
      style={{ backgroundColor: `hsl(${hue(user.accountId)} 45% 45%)` }}
    >
      {initials(user.displayName)}
    </span>
  );
}

export function IssueKey({ issueKey, className }: { issueKey: string; className?: string }) {
  return (
    <span className={cn("shrink-0 font-mono text-xs text-muted-foreground", className)}>
      {issueKey}
    </span>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}
