// Kanban board: one column per status, drag a card to move the issue.
//
// A drop is optimistic — the card moves at once and snaps back with a toast
// if Jira's workflow has no transition into that status. The server's
// "issue-changed" signal then refetches the real state. Status can still be
// changed from the issue view for keyboard users.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { toast } from "sonner";
import type { JiraIssueSummary, JiraStatusOption } from "../../server";
import { cn } from "@/lib/utils";
import { buildBoardColumns, type BoardColumn } from "./board-columns";
import { useJiraRpc } from "./hooks";
import { Avatar, IssueKey, PriorityMark, StatusLozenge, TypeGlyph, errorText } from "./primitives";

const DRAG_TYPE = "application/x-bb-jira-issue";
/** Give up waiting for the refetch to confirm a move after this long. */
const MOVE_SETTLE_MS = 10_000;

const COLUMN_TONE: Record<BoardColumn["category"], string> = {
  todo: "bg-muted-foreground/40",
  inprogress: "bg-sky-500",
  done: "bg-success",
};

export function IssueBoard({
  issues,
  statuses,
  includeDone,
  selectedKey,
  onSelect,
}: {
  issues: JiraIssueSummary[];
  statuses: JiraStatusOption[];
  includeDone: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const rpc = useJiraRpc();
  const [moves, setMoves] = useState<ReadonlyMap<string, JiraStatusOption>>(new Map());
  const [dragging, setDragging] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const columns = useMemo(() => buildBoardColumns(issues, statuses, moves), [issues, statuses, moves]);

  const clearMove = (key: string) =>
    setMoves((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });

  // A move is settled once the refetched list shows the issue in its new status.
  useEffect(() => {
    setMoves((current) => {
      const settled = [...current].filter(([key, status]) => {
        const issue = issues.find((entry) => entry.key === key);
        return issue === undefined || issue.status.toLowerCase() === status.name.toLowerCase();
      });
      if (settled.length === 0) return current;
      const next = new Map(current);
      for (const [key] of settled) next.delete(key);
      return next;
    });
  }, [issues]);

  const drop = (column: BoardColumn, key: string) => {
    const issue = issues.find((entry) => entry.key === key);
    const currentStatus = moves.get(key)?.name ?? issue?.status;
    if (issue === undefined || currentStatus?.toLowerCase() === column.status.toLowerCase()) return;
    setMoves((current) => new Map(current).set(key, { name: column.status, category: column.category }));
    rpc.call("moveIssue", { key, toStatus: column.status }).then(
      () => setTimeout(() => clearMove(key), MOVE_SETTLE_MS),
      (error: unknown) => {
        clearMove(key);
        toast.error(errorText(error));
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-2" role="list" aria-label="Board">
      {columns.map((column) => {
        const id = column.status.toLowerCase();
        const hiddenDone = column.category === "done" && !includeDone && column.issues.length === 0;
        return (
          <section
            key={id}
            role="listitem"
            aria-label={`${column.status}, ${column.issues.length} issues`}
            className={cn(
              "flex max-h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40 transition-colors",
              dragging !== null && overColumn === id && "bg-state-active ring-1 ring-ring",
            )}
            onDragOver={(event: DragEvent) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overColumn !== id) setOverColumn(id);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverColumn(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setOverColumn(null);
              const key = event.dataTransfer.getData(DRAG_TYPE);
              if (key) drop(column, key);
            }}
          >
            <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
              <span className={cn("size-2 shrink-0 rounded-full", COLUMN_TONE[column.category])} />
              <h3 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {column.status}
              </h3>
              <span className="text-xs tabular-nums text-muted-foreground">{column.issues.length}</span>
            </header>
            <ul className="min-h-16 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {column.issues.map((issue) => (
                <li key={issue.key}>
                  <BoardCard
                    issue={issue}
                    selected={issue.key === selectedKey}
                    moving={moves.has(issue.key)}
                    dragging={dragging === issue.key}
                    onSelect={() => onSelect(issue.key)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, issue.key);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(issue.key);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOverColumn(null);
                    }}
                  />
                </li>
              ))}
              {hiddenDone ? (
                <li className="px-1 py-3 text-center text-xs text-muted-foreground">
                  Done issues are hidden. Drop here to finish one.
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({
  issue,
  selected,
  moving,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  issue: JiraIssueSummary;
  selected: boolean;
  moving: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      aria-current={selected ? "true" : undefined}
      aria-label={`${issue.key} ${issue.summary}, ${issue.status}`}
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "block w-full cursor-grab rounded-md border bg-background p-2.5 text-left shadow-sm transition active:cursor-grabbing",
        selected ? "border-ring ring-1 ring-ring" : "border-border hover:border-muted-foreground/40",
        dragging && "opacity-40",
        moving && "animate-pulse",
      )}
    >
      <span className="line-clamp-3 text-sm leading-snug text-foreground">{issue.summary}</span>
      {issue.labels.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {label}
            </span>
          ))}
        </span>
      ) : null}
      <span className="mt-2 flex items-center gap-1.5">
        <TypeGlyph type={issue.issueType} />
        <IssueKey issueKey={issue.key} className="min-w-0 truncate" />
        <span className="flex-1" />
        <PriorityMark priority={issue.priority} />
        <Avatar user={issue.assignee} />
      </span>
      {/* Status is the column; only surface it when a card is mid-move. */}
      {moving ? <StatusLozenge name={issue.status} category={issue.statusCategory} className="mt-1.5" /> : null}
    </button>
  );
}
