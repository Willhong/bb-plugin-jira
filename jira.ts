// The Jira Cloud boundary: wire schemas, normalization into the plugin's own
// types, the write-permission policy, and a small REST v3 client.
//
// Kept out of server.ts so everything here is testable with a fake `fetch`
// and no plugin host. The only type imported by app.tsx is erased at build.
import { z } from "zod";
import { adfToMarkdown, markdownToAdf } from "./adf.js";

export const API_TIMEOUT_MS = 20_000;
export const SEARCH_PAGE_SIZE = 50;
export const COMMENT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Plugin-owned types. Every field is present; the Jira wire shape is parsed
// leniently and defaults are filled exactly once, in `normalize*`.
// ---------------------------------------------------------------------------

/** Jira's three workflow buckets, which is what colors a status everywhere. */
export type StatusCategory = "todo" | "inprogress" | "done";

export interface JiraUser {
  accountId: string;
  displayName: string;
  email: string;
}

export interface JiraIssueSummary {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  issueType: string;
  subtask: boolean;
  priority: string;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  labels: string[];
  created: string;
  updated: string;
}

export interface JiraIssue extends JiraIssueSummary {
  /** Markdown, converted from ADF. */
  description: string;
  parent: { key: string; summary: string } | null;
  url: string;
}

export interface JiraComment {
  id: string;
  author: JiraUser | null;
  body: string;
  created: string;
  updated: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatus: string;
  toCategory: StatusCategory;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraStatusOption {
  name: string;
  category: StatusCategory;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

// ---------------------------------------------------------------------------
// Wire schemas.
// ---------------------------------------------------------------------------

const rawUserSchema = z
  .object({
    accountId: z.string().optional(),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
    accountType: z.string().optional(),
  })
  .loose();

const rawStatusSchema = z
  .object({
    name: z.string().optional(),
    statusCategory: z.object({ key: z.string().optional() }).loose().optional(),
  })
  .loose();

const rawFieldsSchema = z
  .object({
    summary: z.string().nullable().optional(),
    status: rawStatusSchema.nullable().optional(),
    issuetype: z
      .object({ name: z.string().optional(), subtask: z.boolean().optional() })
      .loose()
      .nullable()
      .optional(),
    priority: z.object({ name: z.string().optional() }).loose().nullable().optional(),
    assignee: rawUserSchema.nullable().optional(),
    reporter: rawUserSchema.nullable().optional(),
    labels: z.array(z.string()).nullable().optional(),
    created: z.string().nullable().optional(),
    updated: z.string().nullable().optional(),
    project: z.object({ key: z.string().optional() }).loose().nullable().optional(),
    description: z.unknown().optional(),
    parent: z
      .object({
        key: z.string().optional(),
        fields: z.object({ summary: z.string().optional() }).loose().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export const rawIssueSchema = z
  .object({
    id: z.string().optional(),
    key: z.string(),
    fields: rawFieldsSchema.optional(),
  })
  .loose();

const rawSearchSchema = z
  .object({
    issues: z.array(rawIssueSchema).optional(),
    nextPageToken: z.string().nullable().optional(),
    isLast: z.boolean().optional(),
  })
  .loose();

const rawCommentSchema = z
  .object({
    id: z.string(),
    author: rawUserSchema.nullable().optional(),
    body: z.unknown().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .loose();

const rawTransitionsSchema = z
  .object({
    transitions: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            to: rawStatusSchema.optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

const rawProjectSchema = z
  .object({ id: z.string(), key: z.string(), name: z.string().optional() })
  .loose();

const rawIssueTypeSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    subtask: z.boolean().optional(),
    hierarchyLevel: z.number().optional(),
  })
  .loose();

const rawErrorSchema = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string(), z.string()).optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

export function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

/**
 * Accepts "acme", "acme.atlassian.net", or a full https URL and returns the
 * site origin. Jira Cloud is HTTPS-only, so an http URL is refused rather than
 * silently upgraded.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (/^[a-z0-9][a-z0-9-]*$/i.test(candidate)) {
    candidate = `${candidate}.atlassian.net`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

/** PROJ-123 — uppercase project key, a dash, a number. */
export function isIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]*$/.test(value);
}

export function isProjectKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,254}$/.test(value);
}

export function normalizeIssueKey(value: string): string {
  return value.trim().toUpperCase();
}

export function statusCategory(key: string | undefined): StatusCategory {
  if (key === "done") return "done";
  if (key === "indeterminate") return "inprogress";
  return "todo";
}

function normalizeUser(raw: z.infer<typeof rawUserSchema> | null | undefined): JiraUser | null {
  if (raw === null || raw === undefined || raw.accountId === undefined) return null;
  return {
    accountId: raw.accountId,
    displayName: raw.displayName ?? raw.accountId,
    email: raw.emailAddress ?? "",
  };
}

export function normalizeIssueSummary(raw: z.infer<typeof rawIssueSchema>): JiraIssueSummary {
  const fields = raw.fields ?? {};
  return {
    id: raw.id ?? "",
    key: raw.key,
    projectKey: fields.project?.key ?? raw.key.slice(0, raw.key.lastIndexOf("-")),
    summary: fields.summary ?? "",
    status: fields.status?.name ?? "",
    statusCategory: statusCategory(fields.status?.statusCategory?.key),
    issueType: fields.issuetype?.name ?? "",
    subtask: fields.issuetype?.subtask ?? false,
    priority: fields.priority?.name ?? "",
    assignee: normalizeUser(fields.assignee),
    reporter: normalizeUser(fields.reporter),
    labels: fields.labels ?? [],
    created: fields.created ?? "",
    updated: fields.updated ?? "",
  };
}

export function normalizeIssue(
  raw: z.infer<typeof rawIssueSchema>,
  siteUrl: string,
): JiraIssue {
  const fields = raw.fields ?? {};
  const parent = fields.parent;
  return {
    ...normalizeIssueSummary(raw),
    description: adfToMarkdown(fields.description),
    parent:
      parent?.key === undefined
        ? null
        : { key: parent.key, summary: parent.fields?.summary ?? "" },
    url: `${siteUrl}/browse/${raw.key}`,
  };
}

/** Quotes a value for use inside JQL. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `project = "A"` or `project in ("A", "B")`; "" for no keys. */
export function projectClause(keys: readonly string[]): string {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return "";
  if (unique.length === 1) return `project = ${jqlString(unique[0] ?? "")}`;
  return `project in (${unique.map(jqlString).join(", ")})`;
}

/**
 * Restricts arbitrary JQL to the given projects, keeping its ORDER BY last:
 * `status = Done ORDER BY rank` → `project = "WEB" AND (status = Done) ORDER BY rank`.
 * The ORDER BY is found outside quoted strings, so `text ~ "order by"` is safe.
 */
export function scopeJql(jql: string, keys: readonly string[]): string {
  const clause = projectClause(keys);
  const trimmed = jql.trim();
  if (clause.length === 0) return trimmed;
  let orderAt = -1;
  let quote: string | null = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/^order\s+by\b/i.test(trimmed.slice(index)) && (index === 0 || /\s/.test(trimmed[index - 1] ?? ""))) {
      orderAt = index;
      break;
    }
  }
  const where = (orderAt === -1 ? trimmed : trimmed.slice(0, orderAt)).trim();
  const order = orderAt === -1 ? "" : ` ${trimmed.slice(orderAt).trim()}`;
  return `${where.length > 0 ? `${clause} AND (${where})` : clause}${order}`;
}

export type IssueView = "assigned" | "reported" | "recent" | "all";

/**
 * The JQL behind the panel's saved views. A free-text query narrows any view
 * by summary/description text or, when it looks like an issue key, by key.
 */
export function buildViewJql(args: {
  view: IssueView;
  projectKey: string;
  /** A linked BB project's Jira projects; used when `projectKey` is empty. */
  projectKeys?: readonly string[];
  text: string;
  includeDone: boolean;
  /** Account ids to narrow to. Ignored by the "assigned" view, which is already narrowed. */
  assignees?: string[];
  /** Include unassigned issues in the assignee filter. */
  unassigned?: boolean;
}): string {
  const clauses: string[] = [];
  const projects = projectClause(args.projectKey.length > 0 ? [args.projectKey] : (args.projectKeys ?? []));
  if (projects.length > 0) clauses.push(projects);
  if (args.view === "assigned") {
    clauses.push("assignee = currentUser()");
  } else {
    const people = [...new Set(args.assignees ?? [])];
    const parts: string[] = [];
    if (people.length > 0) parts.push(`assignee in (${people.map(jqlString).join(", ")})`);
    if (args.unassigned === true) parts.push("assignee is EMPTY");
    if (parts.length === 1) clauses.push(parts[0] ?? "");
    if (parts.length > 1) clauses.push(`(${parts.join(" OR ")})`);
  }
  if (args.view === "reported") clauses.push("reporter = currentUser()");
  if (args.view === "recent") clauses.push("updated >= -14d");
  if (!args.includeDone) clauses.push("statusCategory != Done");
  const text = args.text.trim();
  if (text.length > 0) {
    const key = normalizeIssueKey(text);
    clauses.push(
      isIssueKey(key)
        ? `(key = ${jqlString(key)} OR text ~ ${jqlString(text)})`
        : `text ~ ${jqlString(text)}`,
    );
  }
  // Jira's enhanced search rejects an unbounded query, so an empty filter
  // still carries a restriction.
  if (clauses.length === 0) clauses.push("created >= -365d");
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

export function describeUser(user: JiraUser | null): string {
  return user === null ? "Unassigned" : user.displayName;
}

// ---------------------------------------------------------------------------
// Write permissions.
// ---------------------------------------------------------------------------

export const WRITE_ACTIONS = [
  "create",
  "update",
  "transition",
  "comment",
  "assign",
  "delete",
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

export const PERMISSION_ASK = "Ask every time";
export const PERMISSION_ALWAYS = "Always allow";
export const PERMISSION_OPTIONS = [PERMISSION_ASK, PERMISSION_ALWAYS];

/** The settings key that holds one action's policy. */
export function permissionSettingKey(action: WriteAction) {
  return `allow_${action}` as const;
}

export const ACTION_LABELS: Record<WriteAction, string> = {
  create: "Create issues",
  update: "Edit issue fields",
  transition: "Change status",
  comment: "Add comments",
  assign: "Change assignee",
  delete: "Delete issues",
};

/**
 * Anything other than an explicit "Always allow" asks. An unknown or missing
 * stored value therefore fails closed.
 */
export function requiresApproval(policy: unknown): boolean {
  return policy !== PERMISSION_ALWAYS;
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

export interface JiraAccess {
  siteUrl: string;
  email: string;
  apiToken: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

export function describeJiraError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = rawErrorSchema.parse(JSON.parse(body));
    detail = [
      ...(parsed.errorMessages ?? []),
      ...Object.entries(parsed.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ].join("; ");
  } catch {
    detail = body.slice(0, 300);
  }
  return `Jira responded ${status}${detail.length > 0 ? `: ${detail}` : ""}`;
}

export interface IssueFieldsInput {
  summary?: string;
  description?: string;
  priority?: string;
  labels?: string[];
}

export interface CreateIssueInput extends IssueFieldsInput {
  projectKey: string;
  issueType: string;
  summary: string;
  assigneeAccountId?: string;
  parentKey?: string;
}

/** Maps plugin-level field edits onto a Jira `fields` object. */
export function toJiraFields(input: IssueFieldsInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) {
    fields.description =
      input.description.trim().length === 0 ? null : markdownToAdf(input.description);
  }
  if (input.priority !== undefined) fields.priority = { name: input.priority };
  if (input.labels !== undefined) fields.labels = input.labels;
  return fields;
}

const ISSUE_FIELDS =
  "summary,status,issuetype,priority,assignee,reporter,labels,created,updated,project,description,parent";

export class JiraClient {
  constructor(
    private readonly access: JiraAccess,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get siteUrl(): string {
    return this.access.siteUrl;
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const auth = Buffer.from(`${this.access.email}:${this.access.apiToken}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.access.siteUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Could not reach Jira at ${this.access.siteUrl} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    const text = await response.text();
    if (response.status === 401) {
      throw needsConfiguration(
        "Jira rejected the email or API token (HTTP 401). Check the Jira plugin settings.",
      );
    }
    if (!response.ok) {
      throw new JiraError(describeJiraError(response.status, text), response.status);
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Jira returned a non-JSON response");
    }
  }

  async myself(): Promise<JiraUser> {
    const user = normalizeUser(rawUserSchema.parse(await this.request("GET", "/rest/api/3/myself")));
    if (user === null) throw new Error("Jira did not identify the current user");
    return user;
  }

  async search(
    jql: string,
    options: { maxResults?: number; nextPageToken?: string } = {},
  ): Promise<{ issues: JiraIssueSummary[]; nextPageToken: string | null }> {
    const raw = rawSearchSchema.parse(
      await this.request("POST", "/rest/api/3/search/jql", {
        jql,
        maxResults: options.maxResults ?? SEARCH_PAGE_SIZE,
        fields: ISSUE_FIELDS.split(",").filter((field) => field !== "description"),
        ...(options.nextPageToken === undefined ? {} : { nextPageToken: options.nextPageToken }),
      }),
    );
    return {
      issues: (raw.issues ?? []).map(normalizeIssueSummary),
      nextPageToken: raw.isLast === true ? null : (raw.nextPageToken ?? null),
    };
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = rawIssueSchema.parse(
      await this.request(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
      ),
    );
    return normalizeIssue(raw, this.access.siteUrl);
  }

  async createIssue(input: CreateIssueInput): Promise<{ key: string }> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: /^\d+$/.test(input.issueType) ? { id: input.issueType } : { name: input.issueType },
      ...toJiraFields(input),
    };
    if (input.assigneeAccountId !== undefined) {
      fields.assignee = { accountId: input.assigneeAccountId };
    }
    if (input.parentKey !== undefined) fields.parent = { key: input.parentKey };
    const raw = z
      .object({ key: z.string() })
      .loose()
      .parse(await this.request("POST", "/rest/api/3/issue", { fields }));
    return { key: raw.key };
  }

  async updateIssue(key: string, input: IssueFieldsInput): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      fields: toJiraFields(input),
    });
  }

  async deleteIssue(key: string, deleteSubtasks: boolean): Promise<void> {
    await this.request(
      "DELETE",
      `/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=${deleteSubtasks}`,
    );
  }

  async listTransitions(key: string): Promise<JiraTransition[]> {
    const raw = rawTransitionsSchema.parse(
      await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`),
    );
    return (raw.transitions ?? []).map((transition) => ({
      id: transition.id,
      name: transition.name ?? transition.id,
      toStatus: transition.to?.name ?? transition.name ?? "",
      toCategory: statusCategory(transition.to?.statusCategory?.key),
    }));
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  async listComments(key: string): Promise<{ comments: JiraComment[]; total: number }> {
    const raw = z
      .object({
        comments: z.array(rawCommentSchema).optional(),
        total: z.number().optional(),
      })
      .loose()
      .parse(
        await this.request(
          "GET",
          `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=${COMMENT_PAGE_SIZE}`,
        ),
      );
    const comments = (raw.comments ?? []).map((comment) => ({
      id: comment.id,
      author: normalizeUser(comment.author),
      body: adfToMarkdown(comment.body),
      created: comment.created ?? "",
      updated: comment.updated ?? "",
    }));
    // Fetched newest-first so the page holds the latest; shown oldest-first.
    return { comments: comments.reverse(), total: raw.total ?? comments.length };
  }

  async addComment(key: string, markdown: string): Promise<JiraComment> {
    const raw = rawCommentSchema.parse(
      await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        body: markdownToAdf(markdown),
      }),
    );
    return {
      id: raw.id,
      author: normalizeUser(raw.author),
      body: adfToMarkdown(raw.body),
      created: raw.created ?? "",
      updated: raw.updated ?? "",
    };
  }

  async assignIssue(key: string, accountId: string | null): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
      accountId,
    });
  }

  async findAssignableUsers(
    target: { issueKey: string } | { projectKey: string },
    query: string,
  ): Promise<JiraUser[]> {
    const params = new URLSearchParams({ query, maxResults: "20" });
    if ("issueKey" in target) params.set("issueKey", target.issueKey);
    else params.set("project", target.projectKey);
    const raw = z
      .array(rawUserSchema)
      .parse(await this.request("GET", `/rest/api/3/user/assignable/search?${params}`));
    return raw.map(normalizeUser).filter((user): user is JiraUser => user !== null);
  }

  /** Anyone on the site, for filters that are not tied to one project or issue. */
  async searchUsers(query: string): Promise<JiraUser[]> {
    const params = new URLSearchParams({ query, maxResults: "20" });
    const raw = z
      .array(rawUserSchema)
      .parse(await this.request("GET", `/rest/api/3/user/search?${params}`));
    return raw
      // App and customer accounts cannot be assignees.
      .filter((user) => user.accountType === undefined || user.accountType === "atlassian")
      .map(normalizeUser)
      .filter((user): user is JiraUser => user !== null);
  }

  async listProjects(): Promise<JiraProject[]> {
    const raw = z
      .object({ values: z.array(rawProjectSchema).optional() })
      .loose()
      .parse(await this.request("GET", "/rest/api/3/project/search?maxResults=100&orderBy=name"));
    return (raw.values ?? []).map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name ?? project.key,
    }));
  }

  async listIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
    const raw = z
      .object({ issueTypes: z.array(rawIssueTypeSchema).optional() })
      .loose()
      .parse(await this.request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}`));
    return (raw.issueTypes ?? []).map((type) => ({
      id: type.id,
      name: type.name ?? type.id,
      subtask: type.subtask ?? false,
    }));
  }

  /** Every status any of the project's issue types can be in, deduplicated by name. */
  async listProjectStatuses(projectKey: string): Promise<JiraStatusOption[]> {
    const raw = z
      .array(z.object({ statuses: z.array(rawStatusSchema).optional() }).loose())
      .parse(
        await this.request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`),
      );
    const byName = new Map<string, JiraStatusOption>();
    for (const type of raw) {
      for (const status of type.statuses ?? []) {
        if (status.name === undefined || byName.has(status.name)) continue;
        byName.set(status.name, {
          name: status.name,
          category: statusCategory(status.statusCategory?.key),
        });
      }
    }
    return [...byName.values()];
  }

  async listPriorities(): Promise<string[]> {
    const raw = z
      .object({ values: z.array(z.object({ name: z.string() }).loose()).optional() })
      .loose()
      .parse(await this.request("GET", "/rest/api/3/priority/search?maxResults=50"));
    return (raw.values ?? []).map((priority) => priority.name);
  }

  async pickIssues(query: string): Promise<Array<{ key: string; summary: string }>> {
    const params = new URLSearchParams({ query, currentJQL: "" });
    const raw = z
      .object({
        sections: z
          .array(
            z
              .object({
                issues: z
                  .array(z.object({ key: z.string(), summaryText: z.string().optional() }).loose())
                  .optional(),
              })
              .loose(),
          )
          .optional(),
      })
      .loose()
      .parse(await this.request("GET", `/rest/api/3/issue/picker?${params}`));
    const seen = new Set<string>();
    const picked: Array<{ key: string; summary: string }> = [];
    for (const section of raw.sections ?? []) {
      for (const issue of section.issues ?? []) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        picked.push({ key: issue.key, summary: issue.summaryText ?? "" });
      }
    }
    return picked;
  }
}
