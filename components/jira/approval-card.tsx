// The in-thread approval an agent's Jira write blocks on. The server treats
// "once" and "always" as approval and anything else as a refusal, so this
// card fails closed: an unreadable payload offers only Dismiss.
import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface ApprovalPayload {
  action: string;
  actionLabel: string;
  summary: string;
  issueKey: string;
  details: Array<{ label: string; value: string }>;
}

export function readApprovalPayload(payload: unknown): ApprovalPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.action !== "string" ||
    typeof record.actionLabel !== "string" ||
    typeof record.summary !== "string" ||
    typeof record.issueKey !== "string"
  ) {
    return null;
  }
  const details = Array.isArray(record.details) ? record.details : [];
  return {
    action: record.action,
    actionLabel: record.actionLabel,
    summary: record.summary,
    issueKey: record.issueKey,
    details: details.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const detail = entry as Record<string, unknown>;
      return typeof detail.label === "string" && typeof detail.value === "string"
        ? [{ label: detail.label, value: detail.value }]
        : [];
    }),
  };
}

const LONG_VALUE = 160;

export function ApprovalCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [busy, setBusy] = useState(false);
  const payload = readApprovalPayload(interaction.payload);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    void task().finally(() => setBusy(false));
  };

  if (payload === null) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="text-destructive">This Jira approval could not be read, so it cannot be approved.</p>
        <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => run(cancel)}>
          Dismiss
        </Button>
      </div>
    );
  }

  const destructive = payload.action === "delete";
  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border p-3",
        destructive ? "border-destructive/50 bg-destructive/5" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md",
            destructive ? "bg-destructive/15 text-destructive" : "bg-sky-500/15 text-sky-700 dark:text-sky-300",
          )}
        >
          <Icon name={destructive ? "Trash2" : "SecurityCheck"} className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{interaction.title}</p>
          <p className="text-sm text-muted-foreground">{payload.summary}</p>
        </div>
      </div>
      {payload.details.length > 0 ? (
        <dl className="divide-y divide-border overflow-hidden rounded-md border border-border text-sm">
          {payload.details.map((detail) => (
            <div key={detail.label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 px-3 py-1.5">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd
                className={cn(
                  "min-w-0 whitespace-pre-wrap break-words text-foreground",
                  detail.value.length > LONG_VALUE && "max-h-48 overflow-y-auto font-mono text-xs",
                )}
              >
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(cancel)}>
          Decline
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`Always allow agents to ${payload.actionLabel.toLowerCase()}`}
          onClick={() => run(() => submit("always"))}
        >
          Always allow
        </Button>
        <Button
          size="sm"
          variant={destructive ? "destructive" : "default"}
          disabled={busy}
          onClick={() => run(() => submit("once"))}
        >
          {destructive ? "Delete" : "Allow"}
        </Button>
      </div>
    </div>
  );
}
