// The Jira browser: saved views + filters on top, then the issues as a
// grouped list or a status board, with the open issue beside them when there
// is room (over them when there is not). Used full-page in the nav panel and
// narrow in a thread side panel; the split is decided by the width this
// component actually gets.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JiraIssueSummary, JiraStatus, JiraUser } from "../../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AssigneeFilter } from "./assignee-filter";
import { CreateIssueDialog } from "./create-issue-dialog";
import {
  useIssueSearch,
  useJiraStatus,
  useProjectStatuses,
  useProjects,
  type IssueQuery,
  type IssueView,
} from "./hooks";
import { IssueBoard } from "./issue-board";
import { IssueDetail } from "./issue-detail";
import { IssueList } from "./issue-list";
import { PermissionsDialog } from "./permissions-dialog";
import { ProjectLinksDialog, useProjectLink } from "./project-links";
import { Avatar, InlineError } from "./primitives";

/** Below these widths the open issue covers the list or board instead of sitting beside it. */
const LIST_SPLIT_MIN_WIDTH = 960;
const BOARD_SPLIT_MIN_WIDTH = 1280;
const SEARCH_DEBOUNCE_MS = 300;
const ALL_PROJECTS = "__all__";
const QUERY_STORAGE_KEY = "bb-plugin-jira:query";
const LAYOUT_STORAGE_KEY = "bb-plugin-jira:layout";

type Layout = "list" | "board";

const VIEWS: Array<{ view: IssueView; label: string }> = [
  { view: "assigned", label: "Assigned to me" },
  { view: "reported", label: "Reported by me" },
  { view: "recent", label: "Recently updated" },
  { view: "all", label: "All" },
];

const DEFAULT_QUERY: IssueQuery = {
  view: "assigned",
  projectKey: "",
  text: "",
  includeDone: false,
  assignees: [],
  unassigned: false,
  jql: "",
};

function readUsers(value: unknown): JiraUser[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const user = entry as Record<string, unknown>;
    return typeof user.accountId === "string" && typeof user.displayName === "string"
      ? [{ accountId: user.accountId, displayName: user.displayName, email: typeof user.email === "string" ? user.email : "" }]
      : [];
  });
}

/** The last view and filters, remembered per browser so the page reopens where you left it. */
function readStoredQuery(): IssueQuery {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(QUERY_STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_QUERY;
    const record = parsed as Partial<Record<keyof IssueQuery, unknown>>;
    return {
      view: VIEWS.some((entry) => entry.view === record.view) ? (record.view as IssueView) : DEFAULT_QUERY.view,
      projectKey: typeof record.projectKey === "string" ? record.projectKey : "",
      text: "",
      includeDone: record.includeDone === true,
      assignees: readUsers(record.assignees),
      unassigned: record.unassigned === true,
      jql: typeof record.jql === "string" ? record.jql : "",
    };
  } catch {
    return DEFAULT_QUERY;
  }
}

function readStoredLayout(): Layout {
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the choice still applies for this session
  }
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function JiraBrowser({
  selectedKey,
  onSelect,
  compact = false,
  bbProjectId = null,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Thread side panel: no split, tighter chrome. */
  compact?: boolean;
  /**
   * The BB project the browser is opened in (a thread's side panel). When it
   * is linked to Jira projects, issues are limited to them unless the user
   * switches to all projects. Null on the global Jira page.
   */
  bbProjectId?: string | null;
}) {
  const { status } = useJiraStatus();
  const [storedQuery, setQuery] = useState<IssueQuery>(readStoredQuery);
  const link = useProjectLink(bbProjectId);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  useEffect(() => setShowAllProjects(false), [bbProjectId]);
  const scopeKeys = link.keys.length > 0 && !showAllProjects ? link.keys : [];
  // A remembered project outside the linked scope does not apply here.
  const query: IssueQuery =
    scopeKeys.length > 0 && storedQuery.projectKey.length > 0 && !scopeKeys.includes(storedQuery.projectKey)
      ? { ...storedQuery, projectKey: "" }
      : storedQuery;
  const [storedLayout, setLayout] = useState<Layout>(readStoredLayout);
  const [creating, setCreating] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const ready = status?.ready === true;
  const projects = useProjects(ready);
  // Wait for the link before searching, so a linked panel never flashes every project's issues.
  const search = useIssueSearch(query, ready && link.loaded, scopeKeys);
  // A board needs horizontal room; the side panel always lists.
  const layout: Layout = compact ? "list" : storedLayout;
  const boardProject = query.projectKey || (scopeKeys.length === 1 ? (scopeKeys[0] ?? "") : "");
  const statuses = useProjectStatuses(layout === "board" && query.jql.length === 0 ? boardProject : "");

  useEffect(() => {
    // The user's own choice, not the scope-adjusted query, so a linked side
    // panel does not erase the project remembered for the Jira page.
    remember(QUERY_STORAGE_KEY, JSON.stringify({ ...storedQuery, text: "" }));
  }, [storedQuery]);
  useEffect(() => {
    remember(LAYOUT_STORAGE_KEY, storedLayout);
  }, [storedLayout]);

  const split =
    !compact &&
    selectedKey !== null &&
    width >= (layout === "board" ? BOARD_SPLIT_MIN_WIDTH : LIST_SPLIT_MIN_WIDTH);
  const detailOnly = selectedKey !== null && !split;
  // The toolbar spans the page whenever the content does.
  const wide = split || layout === "board";

  if (status === null) {
    return (
      <div ref={rootRef} className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!status.ready) {
    return (
      <div ref={rootRef} className="p-4">
        <ConnectCard status={status} />
      </div>
    );
  }

  const issues = search.issues;
  const loadMore =
    search.nextPageToken !== null ? (
      <Button size="sm" variant="ghost" disabled={search.loadingMore} onClick={search.loadMore}>
        {search.loadingMore ? "Loading…" : "Load more"}
      </Button>
    ) : null;

  const results =
    issues === null ? (
      <div className={cn(layout === "board" ? "flex gap-3" : "space-y-2")}>
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className={layout === "board" ? "h-64 w-72 shrink-0" : "h-10 w-full"} />
        ))}
      </div>
    ) : issues.length === 0 && search.error === null && layout === "list" ? (
      <EmptyList query={query} onCreate={() => setCreating(true)} />
    ) : layout === "board" ? (
      <IssueBoard
        issues={issues}
        statuses={statuses}
        includeDone={query.includeDone}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
    ) : (
      <>
        <IssueList issues={issues} selectedKey={selectedKey} onSelect={onSelect} />
        {loadMore === null ? null : <div className="flex justify-center">{loadMore}</div>}
      </>
    );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {detailOnly ? null : (
        <Toolbar
          query={query}
          setQuery={setQuery}
          layout={layout}
          setLayout={compact ? null : setLayout}
          issues={issues ?? []}
          effectiveJql={search.jql}
          status={status}
          projects={projects}
          count={issues?.length ?? null}
          loadMore={layout === "board" ? loadMore : null}
          hasMore={search.nextPageToken !== null}
          compact={compact}
          wide={wide}
          scope={{
            inProject: bbProjectId !== null,
            linkedKeys: link.keys,
            showAll: showAllProjects,
            setShowAll: setShowAllProjects,
          }}
          onCreate={() => setCreating(true)}
          onPermissions={() => setPermissionsOpen(true)}
          onLinks={() => setLinksOpen(true)}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {detailOnly ? null : (
          <div
            className={cn(
              "min-h-0",
              compact ? "px-3 pb-4 pt-3" : "px-4 pt-5 md:px-5",
              layout === "board"
                ? "flex flex-1 flex-col overflow-hidden"
                : cn("overflow-y-auto pb-6", split ? "w-[26rem] shrink-0 border-r border-border" : "flex-1"),
            )}
          >
            <div
              className={cn(
                "space-y-3",
                layout === "board" && "flex min-h-0 flex-1 flex-col",
                layout === "list" && !split && !compact && "mx-auto max-w-5xl",
              )}
            >
              {search.error !== null ? <InlineError message={search.error} /> : null}
              {results}
            </div>
          </div>
        )}
        {selectedKey !== null ? (
          <div
            className={cn(
              "min-h-0 overflow-y-auto",
              compact ? "flex-1 p-3" : "px-4 pb-3 pt-5 md:px-6",
              split && layout === "board" ? "w-[36rem] shrink-0 border-l border-border" : "flex-1",
            )}
          >
            <div className={cn(!split && !compact && "mx-auto max-w-5xl")}>
              <IssueDetail
                key={selectedKey}
                issueKey={selectedKey}
                currentUser={status.user}
                onClose={() => onSelect(null)}
                onOpenIssue={onSelect}
              />
            </div>
          </div>
        ) : null}
      </div>
      <CreateIssueDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        initialProjectKey={boardProject}
        onCreated={onSelect}
      />
      <PermissionsDialog open={permissionsOpen} onOpenChange={setPermissionsOpen} status={status} />
      <ProjectLinksDialog
        open={linksOpen}
        onOpenChange={setLinksOpen}
        jiraProjects={projects}
        onlyProjectId={bbProjectId}
      />
    </div>
  );
}

interface ScopeProps {
  /** Opened inside a BB project (thread side panel). */
  inProject: boolean;
  linkedKeys: string[];
  showAll: boolean;
  setShowAll: (showAll: boolean) => void;
}

function Toolbar({
  query,
  setQuery,
  layout,
  setLayout,
  issues,
  effectiveJql,
  status,
  projects,
  count,
  loadMore,
  hasMore,
  compact,
  wide,
  scope,
  onCreate,
  onPermissions,
  onLinks,
}: {
  query: IssueQuery;
  setQuery: (query: IssueQuery) => void;
  layout: Layout;
  /** Null where only the list is offered. */
  setLayout: ((layout: Layout) => void) | null;
  issues: JiraIssueSummary[];
  effectiveJql: string;
  status: JiraStatus;
  projects: Array<{ key: string; name: string }>;
  count: number | null;
  /** The board has no bottom edge to page from, so its "Load more" sits here. */
  loadMore: React.ReactNode;
  hasMore: boolean;
  compact: boolean;
  wide: boolean;
  scope: ScopeProps;
  onCreate: () => void;
  onPermissions: () => void;
  onLinks: () => void;
}) {
  const [text, setText] = useState(query.text);
  const [jqlDraft, setJqlDraft] = useState<string | null>(query.jql.length > 0 ? query.jql : null);
  const jqlMode = jqlDraft !== null;
  const frame = !compact && !wide && "mx-auto max-w-5xl";

  useEffect(() => {
    if (text === query.text) return;
    const timer = setTimeout(() => setQuery({ ...query, text }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, query, setQuery]);

  const alwaysAllowed = Object.values(status.permissions).filter((policy) => policy === "always").length;
  const scoped = scope.linkedKeys.length > 0 && !scope.showAll;
  const pickableProjects = scoped ? projects.filter((project) => scope.linkedKeys.includes(project.key)) : projects;

  return (
    <div className={cn("space-y-2.5 border-b border-border pb-3", compact ? "px-3 pt-3" : "px-4 pt-4 md:px-5")}>
      <div className={cn("flex items-center gap-2", frame)}>
        {compact ? null : (
          <div className="flex min-w-0 items-center gap-2">
            <Avatar user={status.user} />
            <span className="truncate text-xs text-muted-foreground">
              {status.siteUrl.replace(/^https:\/\//, "")}
            </span>
          </div>
        )}
        {scope.inProject ? <ScopeControl scope={scope} onLinks={onLinks} /> : null}
        <div className="flex-1" />
        {scope.inProject ? null : (
          <Button size="sm" variant="ghost" onClick={onLinks} aria-label="Link BB projects to Jira projects">
            <Icon name="Plug02" className="size-4" />
            {compact ? null : "Project links"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onPermissions}
          aria-label={`Agent permissions: ${alwaysAllowed} of 6 always allowed`}
        >
          <Icon name="SecurityCheck" className="size-4" />
          {compact ? null : alwaysAllowed === 0 ? "Agents ask first" : `${alwaysAllowed}/6 auto-allowed`}
        </Button>
        <Button size="sm" onClick={onCreate}>
          <Icon name="Plus" className="size-4" />
          Create
        </Button>
      </div>

      <div className={cn("space-y-2", frame)}>
        <div className="flex items-center gap-2">
          {jqlMode ? (
            <span className="text-sm font-medium text-foreground">JQL</span>
          ) : (
            <div role="tablist" aria-label="Saved views" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {VIEWS.map((entry) => (
                <button
                  key={entry.view}
                  type="button"
                  role="tab"
                  aria-selected={query.view === entry.view}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1 text-sm transition-colors",
                    query.view === entry.view
                      ? "bg-state-active font-medium text-foreground"
                      : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                  )}
                  onClick={() => setQuery({ ...query, view: entry.view })}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          {jqlMode ? <div className="flex-1" /> : null}
          {setLayout === null ? null : (
            <div role="radiogroup" aria-label="Layout" className="inline-flex shrink-0 rounded-md border border-border p-0.5">
              {(
                [
                  ["list", "ListView", "List"],
                  ["board", "Columns2", "Board"],
                ] as const
              ).map(([value, icon, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={layout === value}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                    layout === value
                      ? "bg-state-active text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setLayout(value)}
                >
                  <Icon name={icon} className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {jqlMode ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery({ ...query, jql: jqlDraft.trim() });
            }}
          >
            <Input
              autoFocus
              aria-label="JQL"
              value={jqlDraft}
              placeholder="project = PROJ AND statusCategory != Done ORDER BY updated DESC"
              className="h-8 flex-1 font-mono text-xs"
              onChange={(event) => setJqlDraft(event.target.value)}
            />
            <Button size="sm" type="submit">
              Run
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setJqlDraft(null);
                setQuery({ ...query, jql: "" });
              }}
            >
              Basic
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search issues"
                placeholder="Search text or key"
                value={text}
                className="h-8 pl-8 text-sm"
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            {/* A single linked project is already the whole scope. */}
            {scoped && scope.linkedKeys.length === 1 ? null : (
            <Select
              value={query.projectKey || ALL_PROJECTS}
              onValueChange={(value) => setQuery({ ...query, projectKey: value === ALL_PROJECTS ? "" : value })}
            >
              <SelectTrigger className="h-8 w-auto min-w-32 max-w-52 text-sm" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>{scoped ? "All linked projects" : "All projects"}</SelectItem>
                {pickableProjects.map((project) => (
                  <SelectItem key={project.key} value={project.key}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
            {/* "Assigned to me" is already an assignee filter. */}
            {query.view === "assigned" ? null : (
              <AssigneeFilter
                selected={query.assignees}
                unassigned={query.unassigned}
                issues={issues}
                projectKey={query.projectKey}
                onChange={(next) => setQuery({ ...query, ...next })}
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={query.includeDone}
              className="h-8"
              onClick={() => setQuery({ ...query, includeDone: !query.includeDone })}
            >
              Show done
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 font-mono text-xs"
              aria-label="Write JQL"
              onClick={() => setJqlDraft(effectiveJql)}
            >
              JQL
            </Button>
          </div>
        )}
        {count !== null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {count} issue{count === 1 ? "" : "s"}
              {hasMore ? " loaded" : ""}
            </span>
            {loadMore}
            {layout === "board" && query.projectKey.length === 0 && query.jql.length === 0 ? (
              <span className="ml-auto">Pick a project to show every status column.</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ScopeControl({ scope, onLinks }: { scope: ScopeProps; onLinks: () => void }) {
  if (scope.linkedKeys.length === 0) {
    return (
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLinks}>
        <Icon name="Plug02" className="size-3.5" />
        Link a Jira project
      </Button>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div role="radiogroup" aria-label="Issue scope" className="inline-flex min-w-0 rounded-md border border-border p-0.5">
        <button
          type="button"
          role="radio"
          aria-checked={!scope.showAll}
          title={`Only issues in ${scope.linkedKeys.join(", ")}, linked to this BB project`}
          className={cn(
            "min-w-0 truncate rounded px-2 py-0.5 font-mono text-xs transition-colors",
            !scope.showAll ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => scope.setShowAll(false)}
        >
          {scope.linkedKeys.join(", ")}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={scope.showAll}
          className={cn(
            "shrink-0 rounded px-2 py-0.5 text-xs transition-colors",
            scope.showAll ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => scope.setShowAll(true)}
        >
          All Jira
        </button>
      </div>
      <Button size="icon" variant="ghost" className="size-7" aria-label="Change linked Jira projects" onClick={onLinks}>
        <Icon name="Settings" className="size-3.5" />
      </Button>
    </div>
  );
}

function EmptyList({ query, onCreate }: { query: IssueQuery; onCreate: () => void }) {
  const filteredByPeople = query.view !== "assigned" && (query.assignees.length > 0 || query.unassigned);
  const message =
    query.jql.length > 0
      ? "No issues match this JQL."
      : query.text.length > 0
        ? `Nothing matches “${query.text}”.`
        : filteredByPeople
          ? "No issues for the selected assignees."
          : query.view === "assigned"
            ? query.includeDone
              ? "Nothing is assigned to you."
              : "Nothing open is assigned to you."
            : "No issues here.";
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onCreate}>
        <Icon name="Plus" className="size-4" />
        Create issue
      </Button>
    </div>
  );
}

function ConnectCard({ status }: { status: JiraStatus }) {
  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-xl border border-border p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          {status.configured ? "Can't reach Jira" : "Connect Jira Cloud"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {status.configured
            ? "The saved connection didn't work. Check the details below in the plugin settings."
            : "Add your site and an API token in Settings → Plugins → Jira."}
        </p>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground">
        <li>
          <span className="text-muted-foreground">Jira site</span> — e.g. <code>acme.atlassian.net</code>
        </li>
        <li>
          <span className="text-muted-foreground">Account email</span> — the Atlassian account you sign in with
        </li>
        <li>
          <span className="text-muted-foreground">API token</span> — id.atlassian.com → Security → API tokens
        </li>
      </ol>
      {status.configured && status.error !== null ? <InlineError message={status.error} /> : null}
    </div>
  );
}
