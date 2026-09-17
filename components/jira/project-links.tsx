// Linking BB projects to Jira projects. A linked BB project's threads see only
// those Jira projects' issues (search tool, @-mentions, side panel).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { JiraProject, ProjectLinkRow } from "../../server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useJiraRpc } from "./hooks";
import { errorText } from "./primitives";

/** The Jira projects a BB project is linked to, kept live across windows. */
export function useProjectLink(bbProjectId: string | null): { keys: string[]; loaded: boolean } {
  const rpc = useJiraRpc();
  const [state, setState] = useState<{ keys: string[]; loaded: boolean }>({ keys: [], loaded: bbProjectId === null });
  const refetch = useCallback(() => {
    if (bbProjectId === null) return;
    rpc.call("projectLink", { bbProjectId }).then(
      ({ jiraProjectKeys }) => setState({ keys: jiraProjectKeys, loaded: true }),
      () => setState({ keys: [], loaded: true }),
    );
  }, [rpc, bbProjectId]);
  useEffect(() => {
    setState({ keys: [], loaded: bbProjectId === null });
    refetch();
  }, [refetch, bbProjectId]);
  useRealtime("links-changed", refetch);
  return state;
}

/**
 * All BB projects with their links, or just `onlyProjectId` when opened from
 * a thread (where only that project's link is in question).
 */
export function ProjectLinksDialog({
  open,
  onOpenChange,
  jiraProjects,
  onlyProjectId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jiraProjects: JiraProject[];
  onlyProjectId?: string | null;
}) {
  const rpc = useJiraRpc();
  const [rows, setRows] = useState<ProjectLinkRow[] | null>(null);
  const [filter, setFilter] = useState("");

  const refetch = useCallback(() => {
    if (!open) return;
    rpc.call("listProjectLinks", null).then(setRows, (error: unknown) => toast.error(errorText(error)));
  }, [rpc, open]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("links-changed", refetch);

  const visible = useMemo(() => {
    const scoped = (rows ?? []).filter((row) => onlyProjectId === null || row.bbProjectId === onlyProjectId);
    const needle = filter.trim().toLowerCase();
    return needle.length === 0 ? scoped : scoped.filter((row) => row.name.toLowerCase().includes(needle));
  }, [rows, onlyProjectId, filter]);

  const save = (row: ProjectLinkRow, jiraProjectKeys: string[]) => {
    setRows((current) =>
      (current ?? []).map((entry) => (entry.bbProjectId === row.bbProjectId ? { ...entry, jiraProjectKeys } : entry)),
    );
    rpc
      .call("setProjectLink", { bbProjectId: row.bbProjectId, jiraProjectKeys })
      .catch((error: unknown) => {
        toast.error(errorText(error));
        refetch();
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{onlyProjectId === null ? "Project links" : "Link Jira projects"}</DialogTitle>
          <DialogDescription>
            In a linked BB project's threads, agents' Jira searches, @-mentions, and the Jira side panel only
            show the linked Jira projects. Agents can still search everything with jira_search_all_issues.
          </DialogDescription>
        </DialogHeader>
        {onlyProjectId === null ? (
          <Input
            aria-label="Filter BB projects"
            placeholder="Filter BB projects"
            value={filter}
            className="h-8 text-sm"
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        {rows === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No BB projects match.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {visible.map((row) => (
              <li key={row.bbProjectId} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
                <JiraProjectPicker
                  selected={row.jiraProjectKeys}
                  projects={jiraProjects}
                  label={`Jira projects for ${row.name}`}
                  onChange={(keys) => save(row, keys)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function JiraProjectPicker({
  selected,
  projects,
  label,
  onChange,
}: {
  selected: string[];
  projects: JiraProject[];
  label: string;
  onChange: (keys: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const chosen = new Set(selected);
  const needle = query.trim().toLowerCase();
  const shown = projects
    .filter(
      (project) =>
        needle.length === 0 ||
        project.key.toLowerCase().includes(needle) ||
        project.name.toLowerCase().includes(needle),
    )
    .sort((left, right) => Number(chosen.has(right.key)) - Number(chosen.has(left.key)));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={selected.length > 0 ? "secondary" : "outline"}
          className="h-8 max-w-60 shrink-0"
          aria-label={label}
        >
          {selected.length === 0 ? (
            <span className="text-muted-foreground">Not linked</span>
          ) : (
            <span className="truncate font-mono text-xs">{selected.join(", ")}</span>
          )}
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            aria-label="Search Jira projects"
            placeholder="Search Jira projects"
            value={query}
            className="h-8 text-sm"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="max-h-64 overflow-y-auto py-1">
          {shown.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">No Jira projects match.</li>
          ) : (
            shown.map((project) => (
              <li key={project.key}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-state-hover",
                  )}
                >
                  <Checkbox
                    checked={chosen.has(project.key)}
                    onCheckedChange={() =>
                      onChange(
                        chosen.has(project.key)
                          ? selected.filter((key) => key !== project.key)
                          : [...selected, project.key],
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{project.key}</span>
                </label>
              </li>
            ))
          )}
        </ul>
        {selected.length > 0 ? (
          <div className="border-t border-border p-1">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => onChange([])}>
              Unlink all
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
