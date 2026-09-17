// The issue list, grouped the way a board reads: In progress, To do, Done.
// Rows are flex, not a table, so the same list works at full width and in a
// ~320px thread side panel; @container hides secondary columns when narrow.
import { useMemo, useState } from "react";
import type { JiraIssueSummary, StatusCategory } from "../../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  Avatar,
  CATEGORY_LABEL,
  IssueKey,
  PriorityMark,
  StatusLozenge,
  TypeGlyph,
  relativeTime,
} from "./primitives";

const GROUP_ORDER: StatusCategory[] = ["inprogress", "todo", "done"];

export function IssueList({
  issues,
  selectedKey,
  onSelect,
}: {
  issues: JiraIssueSummary[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((category) => ({
        category,
        issues: issues.filter((issue) => issue.statusCategory === category),
      })).filter((group) => group.issues.length > 0),
    [issues],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<StatusCategory>>(new Set());

  return (
    <div className="@container space-y-3">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.category);
        return (
          <section key={group.category} aria-label={CATEGORY_LABEL[group.category]}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-1.5 px-1 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (!next.delete(group.category)) next.add(group.category);
                  return next;
                })
              }
            >
              <Icon
                name="ChevronRight"
                className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")}
              />
              {CATEGORY_LABEL[group.category]}
              <span className="tabular-nums text-muted-foreground/70">{group.issues.length}</span>
            </button>
            {isCollapsed ? null : (
              <ul className="overflow-hidden rounded-lg border border-border">
                {group.issues.map((issue) => (
                  <li key={issue.key} className="border-b border-border last:border-b-0">
                    <IssueRow
                      issue={issue}
                      selected={issue.key === selectedKey}
                      onSelect={() => onSelect(issue.key)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function IssueRow({
  issue,
  selected,
  onSelect,
}: {
  issue: JiraIssueSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
        selected ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      <TypeGlyph type={issue.issueType} />
      <IssueKey issueKey={issue.key} className="hidden @xs:inline" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{issue.summary}</span>
        {/* Narrow: key and status move under the summary. */}
        <span className="mt-0.5 flex items-center gap-2 @md:hidden">
          <IssueKey issueKey={issue.key} className="@xs:hidden" />
          <StatusLozenge name={issue.status} category={issue.statusCategory} />
        </span>
      </span>
      {issue.labels.length > 0 ? (
        <span className="hidden max-w-32 truncate text-xs text-muted-foreground @2xl:inline">
          {issue.labels.join(", ")}
        </span>
      ) : null}
      <span className="hidden whitespace-nowrap text-xs text-muted-foreground @xl:inline">
        {relativeTime(issue.updated)}
      </span>
      <StatusLozenge
        name={issue.status}
        category={issue.statusCategory}
        className="hidden max-w-36 @md:inline-flex"
      />
      <PriorityMark priority={issue.priority} />
      <Avatar user={issue.assignee} />
    </button>
  );
}
