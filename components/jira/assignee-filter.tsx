// Assignee filter: pick any number of people, plus "Unassigned". People
// already on the loaded issues are offered first (the quick picks a board's
// avatar row gives); typing searches the project, or the whole site.
import { useEffect, useMemo, useState } from "react";
import type { JiraIssueSummary, JiraUser } from "../../server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useJiraRpc } from "./hooks";
import { Avatar } from "./primitives";

const SEARCH_DEBOUNCE_MS = 200;
const MAX_STACK = 3;

export function AssigneeFilter({
  selected,
  unassigned,
  onChange,
  issues,
  projectKey,
}: {
  selected: JiraUser[];
  unassigned: boolean;
  onChange: (next: { assignees: JiraUser[]; unassigned: boolean }) => void;
  issues: JiraIssueSummary[];
  projectKey: string;
}) {
  const rpc = useJiraRpc();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraUser[] | null>(null);

  useEffect(() => {
    if (!open || query.trim().length === 0) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      rpc.call("findUsers", { issueKey: "", projectKey, query: query.trim() }).then(
        (users) => live && setResults(users),
        () => live && setResults([]),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, open, query, projectKey]);

  const selectedIds = useMemo(() => new Set(selected.map((user) => user.accountId)), [selected]);

  // Selected people stay listed even after filtering removes their issues.
  const quickPicks = useMemo(() => {
    const byId = new Map<string, JiraUser>();
    for (const user of selected) byId.set(user.accountId, user);
    for (const issue of issues) {
      if (issue.assignee !== null && !byId.has(issue.assignee.accountId)) {
        byId.set(issue.assignee.accountId, issue.assignee);
      }
    }
    return [...byId.values()].sort((left, right) => {
      const rank = Number(!selectedIds.has(left.accountId)) - Number(!selectedIds.has(right.accountId));
      return rank || left.displayName.localeCompare(right.displayName);
    });
  }, [issues, selected, selectedIds]);

  const toggle = (user: JiraUser) =>
    onChange({
      unassigned,
      assignees: selectedIds.has(user.accountId)
        ? selected.filter((entry) => entry.accountId !== user.accountId)
        : [...selected, user],
    });

  const count = selected.length + (unassigned ? 1 : 0);
  const shown = results ?? quickPicks;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={count > 0 ? "secondary" : "ghost"}
          className="h-8 gap-1.5"
          aria-label={count > 0 ? `Assignee filter: ${count} selected` : "Filter by assignee"}
        >
          {count === 0 ? (
            <>
              <Icon name="UserRound" className="size-4" />
              Assignee
            </>
          ) : (
            <>
              <span className="flex -space-x-1.5">
                {unassigned ? <Avatar user={null} className="size-5 bg-background ring-2 ring-background" /> : null}
                {selected.slice(0, MAX_STACK).map((user) => (
                  <Avatar key={user.accountId} user={user} className="size-5 text-[8px] ring-2 ring-background" />
                ))}
              </span>
              {count > MAX_STACK ? <span className="text-xs">+{count - MAX_STACK}</span> : null}
            </>
          )}
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            aria-label="Search people"
            placeholder={projectKey ? `Search people in ${projectKey}` : "Search people"}
            value={query}
            className="h-8 text-sm"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="max-h-72 overflow-y-auto py-1" aria-label="People">
          {results === null ? (
            <PersonRow
              checked={unassigned}
              onToggle={() => onChange({ assignees: selected, unassigned: !unassigned })}
              avatar={<Avatar user={null} />}
              label="Unassigned"
            />
          ) : null}
          {results === null && quickPicks.length > 0 ? (
            <li className="px-3 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">In this view</li>
          ) : null}
          {shown.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {results === null ? "Type to find people." : "No matching people."}
            </li>
          ) : (
            shown.map((user) => (
              <PersonRow
                key={user.accountId}
                checked={selectedIds.has(user.accountId)}
                onToggle={() => toggle(user)}
                avatar={<Avatar user={user} />}
                label={user.displayName}
              />
            ))
          )}
        </ul>
        {count > 0 ? (
          <div className="border-t border-border p-1">
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => onChange({ assignees: [], unassigned: false })}
            >
              Clear filter
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PersonRow({
  checked,
  onToggle,
  avatar,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  avatar: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-state-hover",
          checked && "text-foreground",
        )}
      >
        <Checkbox checked={checked} onCheckedChange={onToggle} />
        {avatar}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </label>
    </li>
  );
}
