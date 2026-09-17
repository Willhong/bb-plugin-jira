// Data hooks over the plugin rpc. Every write on the server publishes
// "issue-changed", so lists and open issues refetch no matter who wrote —
// this panel, another window, or an agent.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  JiraIssueDetail,
  JiraIssueSummary,
  JiraIssueType,
  JiraProject,
  JiraStatus,
  JiraStatusOption,
  JiraUser,
  jiraRpcContract,
} from "../../server";
import { errorText } from "./primitives";

export type IssueView = "assigned" | "reported" | "recent" | "all";

export interface IssueQuery {
  view: IssueView;
  projectKey: string;
  text: string;
  includeDone: boolean;
  /** People to narrow to; kept whole so the filter can show names without a lookup. */
  assignees: JiraUser[];
  unassigned: boolean;
  jql: string;
}

export function useJiraRpc() {
  return useRpc<typeof jiraRpcContract>();
}

function changedKey(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const key = (payload as { key?: unknown }).key;
  return typeof key === "string" ? key : null;
}

export function useJiraStatus(): { status: JiraStatus | null; refetch: () => void } {
  const rpc = useJiraRpc();
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status", null).then(setStatus, () => {});
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("settings-changed", refetch);
  return { status, refetch };
}

/** `scopeKeys` limits results to a linked BB project's Jira projects; [] searches everything. */
export function useIssueSearch(query: IssueQuery, enabled: boolean, scopeKeys: readonly string[] = []) {
  const rpc = useJiraRpc();
  const [state, setState] = useState<{
    issues: JiraIssueSummary[] | null;
    nextPageToken: string | null;
    jql: string;
    error: string | null;
    loadingMore: boolean;
  }>({ issues: null, nextPageToken: null, jql: "", error: null, loadingMore: false });
  // Drop responses from a query the user has already moved past.
  const generation = useRef(0);
  const { view, projectKey, text, includeDone, unassigned, jql } = query;
  // A stable string dependency: the array identity changes on every restore.
  const assigneeIds = query.assignees.map((user) => user.accountId).join(",");
  const scope = scopeKeys.join(",");

  const refetch = useCallback(() => {
    if (!enabled) return;
    const current = ++generation.current;
    const assignees = assigneeIds.length > 0 ? assigneeIds.split(",") : [];
    const scopeList = scope.length > 0 ? scope.split(",") : [];
    rpc.call("search", { view, projectKey, scopeKeys: scopeList, text, includeDone, assignees, unassigned, jql }).then(
      (page) => {
        if (current !== generation.current) return;
        setState({ ...page, error: null, loadingMore: false });
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setState((previous) => ({ ...previous, issues: previous.issues ?? [], error: errorText(error), loadingMore: false }));
      },
    );
  }, [rpc, enabled, view, projectKey, scope, text, includeDone, assigneeIds, unassigned, jql]);

  useEffect(() => {
    setState((previous) => ({ ...previous, issues: null, error: null }));
    refetch();
  }, [refetch]);
  useRealtime("issue-changed", refetch);

  const loadMore = useCallback(() => {
    const token = state.nextPageToken;
    if (token === null || state.loadingMore) return;
    const current = generation.current;
    setState((previous) => ({ ...previous, loadingMore: true }));
    rpc
      .call("search", {
        view,
        projectKey,
        scopeKeys: scope.length > 0 ? scope.split(",") : [],
        text,
        includeDone,
        assignees: assigneeIds.length > 0 ? assigneeIds.split(",") : [],
        unassigned,
        jql,
        nextPageToken: token,
      })
      .then(
        (page) => {
          if (current !== generation.current) return;
          setState((previous) => ({
            ...previous,
            issues: [...(previous.issues ?? []), ...page.issues],
            nextPageToken: page.nextPageToken,
            loadingMore: false,
          }));
        },
        (error: unknown) =>
          setState((previous) => ({ ...previous, error: errorText(error), loadingMore: false })),
      );
  }, [rpc, state.nextPageToken, state.loadingMore, view, projectKey, scope, text, includeDone, assigneeIds, unassigned, jql]);

  return { ...state, refetch, loadMore };
}

export function useIssueDetail(issueKey: string) {
  const rpc = useJiraRpc();
  const [state, setState] = useState<{
    detail: JiraIssueDetail | null;
    error: string | null;
    deleted: boolean;
  }>({ detail: null, error: null, deleted: false });

  const refetch = useCallback(() => {
    rpc.call("getIssue", { key: issueKey }).then(
      (detail) => setState({ detail, error: null, deleted: false }),
      (error: unknown) => setState((previous) => ({ ...previous, error: errorText(error) })),
    );
  }, [rpc, issueKey]);

  useEffect(() => {
    setState({ detail: null, error: null, deleted: false });
    refetch();
  }, [refetch]);

  useRealtime("issue-changed", (payload) => {
    if (changedKey(payload) !== issueKey) return;
    if ((payload as { deleted?: unknown }).deleted === true) {
      setState({ detail: null, error: null, deleted: true });
      return;
    }
    refetch();
  });

  return { ...state, refetch };
}

export function useProjects(enabled: boolean): JiraProject[] {
  const rpc = useJiraRpc();
  const [projects, setProjects] = useState<JiraProject[]>([]);
  useEffect(() => {
    if (!enabled) return;
    rpc.call("listProjects", null).then(setProjects, () => {});
  }, [rpc, enabled]);
  return projects;
}

export function useCreateOptions(projectKey: string): {
  issueTypes: JiraIssueType[];
  priorities: string[];
  loading: boolean;
} {
  const rpc = useJiraRpc();
  const [state, setState] = useState<{ issueTypes: JiraIssueType[]; priorities: string[]; loading: boolean }>({
    issueTypes: [],
    priorities: [],
    loading: false,
  });
  useEffect(() => {
    if (projectKey.length === 0) {
      setState({ issueTypes: [], priorities: [], loading: false });
      return;
    }
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    rpc.call("createOptions", { projectKey }).then(
      (options) => live && setState({ ...options, loading: false }),
      () => live && setState({ issueTypes: [], priorities: [], loading: false }),
    );
    return () => {
      live = false;
    };
  }, [rpc, projectKey]);
  return state;
}

/** The selected project's statuses, so the board has a column for each. */
export function useProjectStatuses(projectKey: string): JiraStatusOption[] {
  const rpc = useJiraRpc();
  const [statuses, setStatuses] = useState<JiraStatusOption[]>([]);
  useEffect(() => {
    setStatuses([]);
    if (projectKey.length === 0) return;
    let live = true;
    rpc.call("projectStatuses", { projectKey }).then(
      (next) => live && setStatuses(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rpc, projectKey]);
  return statuses;
}
