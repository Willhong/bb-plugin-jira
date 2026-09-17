// Agent write permissions, one row per action. The same values are editable
// in BB's plugin settings; this is the in-context shortcut.
import { useState } from "react";
import { toast } from "sonner";
import type { JiraStatus, WriteAction } from "../../server";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useJiraRpc } from "./hooks";
import { errorText } from "./primitives";

export const ACTION_ROWS: Array<{ action: WriteAction; label: string; hint: string }> = [
  { action: "create", label: "Create issues", hint: "jira_create_issue" },
  { action: "update", label: "Edit fields", hint: "Summary, description, priority, labels" },
  { action: "transition", label: "Change status", hint: "Workflow transitions" },
  { action: "comment", label: "Add comments", hint: "jira_add_comment" },
  { action: "assign", label: "Change assignee", hint: "jira_assign_issue" },
  { action: "delete", label: "Delete issues", hint: "Permanent" },
];

export function PermissionsDialog({
  open,
  onOpenChange,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: JiraStatus | null;
}) {
  const rpc = useJiraRpc();
  const [pending, setPending] = useState<WriteAction | null>(null);

  const set = (action: WriteAction, policy: "ask" | "always") => {
    if (status?.permissions[action] === policy) return;
    setPending(action);
    rpc
      .call("setPermissions", { permissions: { [action]: policy } })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(null));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Agent permissions</DialogTitle>
          <DialogDescription>
            What agents may change in Jira without asking. Your own edits in this panel are never
            gated. Applies across all projects.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {ACTION_ROWS.map((row) => {
            const policy = status?.permissions[row.action] ?? "ask";
            return (
              <li key={row.action} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm text-foreground", row.action === "delete" && "text-destructive")}>
                    {row.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{row.hint}</p>
                </div>
                <div
                  role="radiogroup"
                  aria-label={row.label}
                  className="inline-flex shrink-0 rounded-md border border-border p-0.5"
                >
                  {(["ask", "always"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={policy === option}
                      disabled={pending === row.action || status === null}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-60",
                        policy === option
                          ? option === "always"
                            ? "bg-foreground text-background"
                            : "bg-state-active text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => set(row.action, option)}
                    >
                      {option === "ask" ? "Ask" : "Always allow"}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
