// bb-plugin-jira — the backend.
//
// Jira Cloud issues in BB: search, read, create, edit, transition, comment,
// assign, and delete — from the panel and from agents.
//
// Writes are split by who is acting:
//   - In the panel, the user's own click is the intent. Only delete confirms.
//   - An agent's write goes through `authorizeAgentWrite`, which honors the
//     per-action policy in settings ("Ask every time" / "Always allow"). Asking
//     blocks on `bb.ui.requestInput`; the approval card can also flip that
//     action to "Always allow" for next time.
// Every agent write tool must call `authorizeAgentWrite` before touching Jira.
//
// Project links: a BB project can be linked to Jira projects. In that
// project's threads, jira_search_issues, @-mentions, and the side panel only
// show the linked projects' issues; jira_search_all_issues searches everything.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ACTION_LABELS,
  JiraClient,
  PERMISSION_ALWAYS,
  PERMISSION_ASK,
  PERMISSION_OPTIONS,
  WRITE_ACTIONS,
  buildViewJql,
  describeUser,
  isIssueKey,
  isProjectKey,
  needsConfiguration,
  normalizeIssueKey,
  normalizeSiteUrl,
  requiresApproval,
  scopeJql,
  type JiraComment,
  type JiraIssue,
  type JiraIssueSummary,
  type JiraUser,
  type WriteAction,
} from "./jira.js";

const APPROVAL_RENDERER_ID = "jira-approve-write";
const ISSUE_CHANGED = "issue-changed";
const SETTINGS_CHANGED = "settings-changed";
const LINKS_CHANGED = "links-changed";
/** kv: Record<bbProjectId, jiraProjectKey[]> */
const LINKS_KEY = "project-links";
const AGENT_SEARCH_MAX = 50;

const CONFIG_HINT =
  "Set your Jira site, account email, and an API token (id.atlassian.com → Security → API tokens) in the Jira plugin settings.";

export type {
  JiraComment,
  JiraIssue,
  JiraIssueSummary,
  JiraIssueType,
  JiraProject,
  JiraStatusOption,
  JiraTransition,
  JiraUser,
  StatusCategory,
  WriteAction,
} from "./jira.js";

// ---------------------------------------------------------------------------
// rpc contract. Outputs are passed through as-is: they are built by the
// normalizers in jira.ts, which already fix their shape.
// ---------------------------------------------------------------------------

const issueKeyInput = z
  .string()
  .transform(normalizeIssueKey)
  .refine(isIssueKey, "Expected an issue key such as PROJ-123");

const projectKeyInput = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isProjectKey, "Expected a project key such as PROJ");

const anyOutput = <T>() => z.custom<T>(() => true);

const permissionsSchema = z.record(z.string(), z.enum(["ask", "always"]));

export interface JiraStatus {
  configured: boolean;
  ready: boolean;
  siteUrl: string;
  user: JiraUser | null;
  error: string | null;
  permissions: Record<WriteAction, "ask" | "always">;
}

export interface JiraIssueDetail {
  issue: JiraIssue;
  comments: JiraComment[];
  commentTotal: number;
  transitions: import("./jira.js").JiraTransition[];
  threads: ThreadLink[];
}

export interface ProjectLinkRow {
  bbProjectId: string;
  name: string;
  jiraProjectKeys: string[];
}

/** Where "Send to agent" can start a thread for one issue. */
export interface AgentTargets {
  jiraProjectKey: string;
  /** BB projects linked to the issue's Jira project, by name. */
  linked: Array<{ bbProjectId: string; name: string }>;
  /** Every BB project, by name, for when none (or another) is wanted. */
  all: Array<{ bbProjectId: string; name: string }>;
}

export interface ThreadLink {
  threadId: string;
  createdAt: string;
}

export const jiraRpcContract = defineRpcContract({
  status: { input: z.null(), output: anyOutput<JiraStatus>() },
  search: {
    input: z
      .object({
        view: z.enum(["assigned", "reported", "recent", "all"]),
        projectKey: z.string().default(""),
        /**
         * Restrict to these Jira projects (a linked BB project's scope). Applies
         * to both the view query and custom JQL; `projectKey` narrows further.
         */
        scopeKeys: z.array(projectKeyInput).max(50).default([]),
        text: z.string().max(500).default(""),
        includeDone: z.boolean().default(false),
        assignees: z.array(z.string().min(1).max(128)).max(50).default([]),
        unassigned: z.boolean().default(false),
        /** When set, replaces the view-built query entirely. */
        jql: z.string().max(4000).default(""),
        nextPageToken: z.string().optional(),
      })
      .strict(),
    output: anyOutput<{
      issues: JiraIssueSummary[];
      nextPageToken: string | null;
      jql: string;
    }>(),
  },
  getIssue: {
    input: z.object({ key: issueKeyInput }).strict(),
    output: anyOutput<JiraIssueDetail>(),
  },
  listProjects: {
    input: z.null(),
    output: anyOutput<import("./jira.js").JiraProject[]>(),
  },
  createOptions: {
    input: z.object({ projectKey: projectKeyInput }).strict(),
    output: anyOutput<{
      issueTypes: import("./jira.js").JiraIssueType[];
      priorities: string[];
    }>(),
  },
  listProjectLinks: {
    input: z.null(),
    output: anyOutput<ProjectLinkRow[]>(),
  },
  /** The Jira projects one BB project is linked to; [] when unlinked. */
  projectLink: {
    input: z.object({ bbProjectId: z.string().min(1) }).strict(),
    output: z.object({ jiraProjectKeys: z.array(z.string()) }),
  },
  setProjectLink: {
    input: z
      .object({ bbProjectId: z.string().min(1), jiraProjectKeys: z.array(projectKeyInput).max(50) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  projectStatuses: {
    input: z.object({ projectKey: projectKeyInput }).strict(),
    output: anyOutput<import("./jira.js").JiraStatusOption[]>(),
  },
  findUsers: {
    input: z
      .object({
        issueKey: z.string().default(""),
        projectKey: z.string().default(""),
        query: z.string().max(200).default(""),
      })
      .strict(),
    output: anyOutput<JiraUser[]>(),
  },
  createIssue: {
    input: z
      .object({
        projectKey: projectKeyInput,
        issueType: z.string().min(1),
        summary: z.string().trim().min(1).max(255),
        description: z.string().max(32_000).default(""),
        priority: z.string().default(""),
        assigneeAccountId: z.string().default(""),
      })
      .strict(),
    output: z.object({ key: z.string() }),
  },
  updateIssue: {
    input: z
      .object({
        key: issueKeyInput,
        summary: z.string().trim().min(1).max(255).optional(),
        description: z.string().max(32_000).optional(),
        priority: z.string().min(1).optional(),
        labels: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  transitionIssue: {
    input: z.object({ key: issueKeyInput, transitionId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /** The board's drop: find the transition into a status by name and take it. */
  moveIssue: {
    input: z.object({ key: issueKeyInput, toStatus: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  addComment: {
    input: z.object({ key: issueKeyInput, body: z.string().trim().min(1).max(32_000) }).strict(),
    output: anyOutput<JiraComment>(),
  },
  assignIssue: {
    input: z.object({ key: issueKeyInput, accountId: z.string().min(1).nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  deleteIssue: {
    input: z.object({ key: issueKeyInput, deleteSubtasks: z.boolean().default(false) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setPermissions: {
    input: z.object({ permissions: permissionsSchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  agentTargets: {
    input: z.object({ key: issueKeyInput }).strict(),
    output: anyOutput<AgentTargets>(),
  },
  sendToAgent: {
    input: z
      .object({
        key: issueKeyInput,
        /** The BB project whose chat the thread starts in. */
        bbProjectId: z.string().min(1),
        note: z.string().max(4000).default(""),
        /** Also link the issue's Jira project to that BB project. */
        linkProject: z.boolean().default(false),
      })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
});

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

export function formatIssueRow(issue: JiraIssueSummary): string {
  return [
    issue.key,
    issue.issueType,
    issue.status,
    issue.priority || "-",
    describeUser(issue.assignee),
    issue.summary,
  ].join("\t");
}

export function formatIssue(
  issue: JiraIssue,
  comments: JiraComment[],
  commentTotal: number,
): string {
  const lines = [
    `${issue.key}: ${issue.summary}`,
    `URL: ${issue.url}`,
    `Type: ${issue.issueType}`,
    `Status: ${issue.status}`,
    `Priority: ${issue.priority || "-"}`,
    `Assignee: ${describeUser(issue.assignee)}`,
    `Reporter: ${describeUser(issue.reporter)}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    issue.parent === null ? "" : `Parent: ${issue.parent.key} ${issue.parent.summary}`,
    `Created: ${issue.created}`,
    `Updated: ${issue.updated}`,
    "",
    "Description:",
    issue.description.length > 0 ? issue.description : "(empty)",
  ];
  if (comments.length > 0) {
    lines.push(
      "",
      commentTotal > comments.length
        ? `Comments (latest ${comments.length} of ${commentTotal}):`
        : `Comments (${comments.length}):`,
    );
    for (const comment of comments) {
      lines.push(`--- ${describeUser(comment.author)} at ${comment.created}`, comment.body);
    }
  }
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

/** Picks one user for a free-form assignee reference, or explains why not. */
export function matchUser(
  candidates: JiraUser[],
  reference: string,
): { user: JiraUser } | { error: string } {
  const needle = reference.trim().toLowerCase();
  const exact = candidates.filter(
    (user) =>
      user.accountId === reference.trim() ||
      user.email.toLowerCase() === needle ||
      user.displayName.toLowerCase() === needle,
  );
  const pool = exact.length > 0 ? exact : candidates;
  const [first] = pool;
  if (pool.length === 1 && first !== undefined) return { user: first };
  if (pool.length === 0) {
    return { error: `No assignable Jira user matches "${reference}".` };
  }
  return {
    error: `"${reference}" matches several users: ${pool
      .slice(0, 10)
      .map((user) => `${user.displayName}${user.email ? ` <${user.email}>` : ""}`)
      .join(", ")}. Use a more specific name or the email address.`,
  };
}

export function matchTransition<T extends { id: string; name: string; toStatus: string }>(
  transitions: T[],
  target: string,
): { transition: T } | { error: string } {
  const needle = target.trim().toLowerCase();
  const found =
    transitions.find((transition) => transition.id === target.trim()) ??
    transitions.find((transition) => transition.name.toLowerCase() === needle) ??
    transitions.find((transition) => transition.toStatus.toLowerCase() === needle);
  if (found !== undefined) return { transition: found };
  return {
    error:
      transitions.length === 0
        ? "This issue has no transitions available to the current user."
        : `No transition matches "${target}". Available: ${transitions
            .map((transition) => `${transition.name} → ${transition.toStatus}`)
            .join(", ")}.`,
  };
}

// ---------------------------------------------------------------------------

type ToolResult = string | { content: Array<{ type: "text"; text: string }>; isError: true };

function toolError(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    siteUrl: {
      type: "string",
      label: "Jira site",
      description: "Your Jira Cloud site, e.g. acme.atlassian.net.",
      default: "",
    },
    email: {
      type: "string",
      label: "Account email",
      description: "The Atlassian account the API token belongs to.",
      default: "",
    },
    apiToken: {
      type: "string",
      label: "API token",
      description: "Create one at id.atlassian.com → Security → API tokens.",
      secret: true,
    },
    allow_create: {
      type: "select",
      label: "Agents: create issues",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
    allow_update: {
      type: "select",
      label: "Agents: edit issue fields",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
    allow_transition: {
      type: "select",
      label: "Agents: change status",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
    allow_comment: {
      type: "select",
      label: "Agents: add comments",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
    allow_assign: {
      type: "select",
      label: "Agents: change assignee",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
    allow_delete: {
      type: "select",
      label: "Agents: delete issues",
      options: PERMISSION_OPTIONS,
      default: PERMISSION_ASK,
    },
  });

  async function client(): Promise<JiraClient> {
    const values = await settings.get();
    const siteUrl = normalizeSiteUrl(values.siteUrl);
    const email = values.email.trim();
    const apiToken = values.apiToken?.trim() ?? "";
    if (siteUrl === null) throw needsConfiguration(`No Jira site is set. ${CONFIG_HINT}`);
    if (email.length === 0 || apiToken.length === 0) {
      throw needsConfiguration(`No Jira email or API token is set. ${CONFIG_HINT}`);
    }
    return new JiraClient({ siteUrl, email, apiToken });
  }

  async function permissions(): Promise<Record<WriteAction, "ask" | "always">> {
    const values = await settings.get();
    const result = {} as Record<WriteAction, "ask" | "always">;
    for (const action of WRITE_ACTIONS) {
      result[action] = requiresApproval(values[`allow_${action}`]) ? "ask" : "always";
    }
    return result;
  }

  async function setPermission(action: WriteAction, policy: "ask" | "always"): Promise<void> {
    await settings.experimental_set({
      [`allow_${action}`]: policy === "always" ? PERMISSION_ALWAYS : PERMISSION_ASK,
    });
  }

  settings.onChange(() => {
    bb.realtime.publish(SETTINGS_CHANGED, {});
  });

  // ------------------------------------------------------------------
  // BB project ↔ Jira project links. Mirrored in memory because
  // contributeInstructions must answer synchronously.
  // ------------------------------------------------------------------

  const links = new Map<string, string[]>(
    Object.entries((await bb.storage.kv.get<Record<string, string[]>>(LINKS_KEY)) ?? {}),
  );

  async function saveLink(bbProjectId: string, jiraProjectKeys: string[]): Promise<void> {
    const keys = [...new Set(jiraProjectKeys)];
    if (keys.length === 0) links.delete(bbProjectId);
    else links.set(bbProjectId, keys);
    await bb.storage.kv.set(LINKS_KEY, Object.fromEntries(links));
    bb.realtime.publish(LINKS_CHANGED, { bbProjectId, jiraProjectKeys: keys });
  }

  function linkedKeys(bbProjectId: string | null | undefined): string[] {
    return bbProjectId ? (links.get(bbProjectId) ?? []) : [];
  }

  function published(key: string, deleted = false): void {
    bb.realtime.publish(ISSUE_CHANGED, { key, deleted });
  }

  // ------------------------------------------------------------------
  // Agent write gate.
  // ------------------------------------------------------------------

  interface WriteRequest {
    action: WriteAction;
    /** One line naming exactly what will change. */
    summary: string;
    issueKey: string;
    details: Array<{ label: string; value: string }>;
  }

  /** Returns null when the write may proceed, or a refusal for the model. */
  async function authorizeAgentWrite(
    request: WriteRequest,
    ctx: { threadId: string; signal: AbortSignal },
  ): Promise<string | null> {
    if (!requiresApproval((await settings.get())[`allow_${request.action}`])) return null;
    let result;
    try {
      result = await bb.ui.requestInput(
        {
          threadId: ctx.threadId,
          rendererId: APPROVAL_RENDERER_ID,
          title: `Allow the agent to ${ACTION_LABELS[request.action].toLowerCase()}?`,
          payload: {
            action: request.action,
            actionLabel: ACTION_LABELS[request.action],
            summary: request.summary,
            issueKey: request.issueKey,
            details: request.details,
          },
        },
        { signal: ctx.signal },
      );
    } catch (error) {
      return `The approval prompt could not be shown (${
        error instanceof Error ? error.message : String(error)
      }). Nothing was sent to Jira. Retry after any other pending prompt resolves.`;
    }
    if (result.outcome === "cancelled") {
      return result.reason === "timeout"
        ? "The approval timed out, so nothing was sent to Jira."
        : "The user declined, so nothing was sent to Jira.";
    }
    if (result.value === "always") {
      await setPermission(request.action, "always");
      bb.log.info(`agent writes of kind "${request.action}" set to always allow`);
      return null;
    }
    return result.value === "once" ? null : "The user declined, so nothing was sent to Jira.";
  }

  // ------------------------------------------------------------------
  // Shared operations.
  // ------------------------------------------------------------------

  async function resolveAssignee(
    jira: JiraClient,
    issueKey: string,
    reference: string,
  ): Promise<{ user: JiraUser | null } | { error: string }> {
    const value = reference.trim();
    const lower = value.toLowerCase();
    if (lower === "" || lower === "none" || lower === "unassigned") return { user: null };
    if (lower === "me") return { user: await jira.myself() };
    return matchUser(await jira.findAssignableUsers({ issueKey }, value), value);
  }

  async function loadIssueDetail(key: string): Promise<JiraIssueDetail> {
    const jira = await client();
    const [issue, comments, transitions] = await Promise.all([
      jira.getIssue(key),
      jira.listComments(key),
      jira.listTransitions(key),
    ]);
    return {
      issue,
      comments: comments.comments,
      commentTotal: comments.total,
      transitions,
      threads: (await bb.storage.kv.get<ThreadLink[]>(`threads:${key}`)) ?? [],
    };
  }

  async function listBbProjects(): Promise<Array<{ bbProjectId: string; name: string }>> {
    const projects = (await bb.sdk.projects.list()) as unknown as Array<{ id: string; name: string }>;
    return projects
      .map((project) => ({ bbProjectId: project.id, name: project.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function agentTargets(key: string): Promise<AgentTargets> {
    const jiraProjectKey = key.slice(0, key.lastIndexOf("-"));
    const all = await listBbProjects();
    return {
      jiraProjectKey,
      linked: all.filter((project) => linkedKeys(project.bbProjectId).includes(jiraProjectKey)),
      all,
    };
  }

  async function sendToAgent(args: {
    key: string;
    bbProjectId: string;
    note: string;
    linkProject: boolean;
  }): Promise<string> {
    const { key, note } = args;
    const projectId = args.bbProjectId;
    // The panel only offers real projects, but the id still crosses the wire.
    if (!(await listBbProjects()).some((project) => project.bbProjectId === projectId)) {
      throw new Error("That BB project no longer exists.");
    }
    const jira = await client();
    const [issue, comments] = await Promise.all([jira.getIssue(key), jira.listComments(key)]);
    if (args.linkProject && !linkedKeys(projectId).includes(issue.projectKey)) {
      await saveLink(projectId, [...linkedKeys(projectId), issue.projectKey]);
    }
    const prompt = [
      `Work on Jira issue ${issue.key}.`,
      note.trim().length > 0 ? `\nInstructions from the user:\n${note.trim()}\n` : "",
      "```text",
      formatIssue(issue, comments.comments, comments.total),
      "```",
      "",
      "Use the jira_* tools to read or update this issue as the work progresses.",
    ]
      .filter((line) => line !== "")
      .join("\n");
    const thread = (await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `${issue.key}: ${issue.summary}`.slice(0, 120),
      prompt,
    })) as unknown as { id: string };
    const links = (await bb.storage.kv.get<ThreadLink[]>(`threads:${key}`)) ?? [];
    await bb.storage.kv.set(`threads:${key}`, [
      ...links,
      { threadId: thread.id, createdAt: new Date().toISOString() },
    ]);
    published(key);
    return thread.id;
  }

  // Report an unconfigured install up front instead of on first use.
  try {
    await (await client()).myself();
  } catch (error) {
    if (error instanceof Error && error.name === "NeedsConfigurationError") {
      bb.status.needsConfiguration(error.message);
    } else {
      bb.log.warn(`Jira check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // rpc — the panel. These are the user's own actions, so they do not pass
  // through the agent gate; the panel confirms delete itself.
  // ------------------------------------------------------------------

  bb.rpc.register(jiraRpcContract, {
    async status() {
      const values = await settings.get();
      const siteUrl = normalizeSiteUrl(values.siteUrl) ?? "";
      const base = { siteUrl, permissions: await permissions() };
      try {
        const user = await (await client()).myself();
        return { ...base, configured: true, ready: true, user, error: null };
      } catch (error) {
        return {
          ...base,
          configured: !(error instanceof Error && error.name === "NeedsConfigurationError"),
          ready: false,
          user: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async search({ view, projectKey, scopeKeys, text, includeDone, assignees, unassigned, jql, nextPageToken }) {
      const narrowed = projectKey.trim().toUpperCase();
      // A project picked inside a linked scope must stay inside it.
      const keys = narrowed.length > 0 && (scopeKeys.length === 0 || scopeKeys.includes(narrowed)) ? [narrowed] : scopeKeys;
      const query =
        jql.trim().length > 0
          ? scopeJql(jql, keys)
          : buildViewJql({ view, projectKey: "", projectKeys: keys, text, includeDone, assignees, unassigned });
      const page = await (await client()).search(query, {
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
      return { ...page, jql: query };
    },

    getIssue: ({ key }) => loadIssueDetail(key),

    listProjects: async () => (await client()).listProjects(),

    async createOptions({ projectKey }) {
      const jira = await client();
      const [issueTypes, priorities] = await Promise.all([
        jira.listIssueTypes(projectKey),
        jira.listPriorities().catch(() => []),
      ]);
      return { issueTypes, priorities };
    },

    async listProjectLinks() {
      const projects = (await bb.sdk.projects.list()) as unknown as Array<{ id: string; name: string }>;
      const rows = projects.map((project) => ({
        bbProjectId: project.id,
        name: project.name,
        jiraProjectKeys: links.get(project.id) ?? [],
      }));
      // Linked projects first, so the ones in use are not buried.
      return rows.sort(
        (left, right) =>
          Number(right.jiraProjectKeys.length > 0) - Number(left.jiraProjectKeys.length > 0) ||
          left.name.localeCompare(right.name),
      );
    },

    projectLink: async ({ bbProjectId }) => ({ jiraProjectKeys: links.get(bbProjectId) ?? [] }),

    async setProjectLink({ bbProjectId, jiraProjectKeys }) {
      await saveLink(bbProjectId, jiraProjectKeys);
      return { ok: true as const };
    },

    projectStatuses: async ({ projectKey }) => (await client()).listProjectStatuses(projectKey),

    async findUsers({ issueKey, projectKey, query }) {
      const jira = await client();
      const key = normalizeIssueKey(issueKey);
      if (isIssueKey(key)) return jira.findAssignableUsers({ issueKey: key }, query);
      const project = projectKey.trim().toUpperCase();
      if (isProjectKey(project)) return jira.findAssignableUsers({ projectKey: project }, query);
      return jira.searchUsers(query);
    },

    async createIssue(input) {
      const created = await (await client()).createIssue({
        projectKey: input.projectKey,
        issueType: input.issueType,
        summary: input.summary,
        ...(input.description.trim().length > 0 ? { description: input.description } : {}),
        ...(input.priority.length > 0 ? { priority: input.priority } : {}),
        ...(input.assigneeAccountId.length > 0
          ? { assigneeAccountId: input.assigneeAccountId }
          : {}),
      });
      published(created.key);
      return created;
    },

    async updateIssue({ key, ...fields }) {
      await (await client()).updateIssue(key, fields);
      published(key);
      return { ok: true as const };
    },

    async transitionIssue({ key, transitionId }) {
      await (await client()).transitionIssue(key, transitionId);
      published(key);
      return { ok: true as const };
    },

    async moveIssue({ key, toStatus }) {
      const jira = await client();
      const matched = matchTransition(
        (await jira.listTransitions(key)).filter(
          (transition) => transition.toStatus.toLowerCase() === toStatus.toLowerCase(),
        ),
        toStatus,
      );
      if ("error" in matched) {
        throw new Error(`${key} can't move to ${toStatus} from its current status in this workflow.`);
      }
      await jira.transitionIssue(key, matched.transition.id);
      published(key);
      return { ok: true as const };
    },

    async addComment({ key, body }) {
      const comment = await (await client()).addComment(key, body);
      published(key);
      return comment;
    },

    async assignIssue({ key, accountId }) {
      await (await client()).assignIssue(key, accountId);
      published(key);
      return { ok: true as const };
    },

    async deleteIssue({ key, deleteSubtasks }) {
      await (await client()).deleteIssue(key, deleteSubtasks);
      await bb.storage.kv.delete(`threads:${key}`);
      published(key, true);
      return { ok: true as const };
    },

    async setPermissions({ permissions: next }) {
      for (const action of WRITE_ACTIONS) {
        const policy = next[action];
        if (policy !== undefined) await setPermission(action, policy);
      }
      return { ok: true as const };
    },

    agentTargets: ({ key }) => agentTargets(key),

    sendToAgent: async (input) => ({ threadId: await sendToAgent(input) }),
  });

  // ------------------------------------------------------------------
  // Agent tools.
  // ------------------------------------------------------------------

  const keyParam = z.string().min(1).describe("Issue key, e.g. PROJ-123.");

  const searchParameters = z.object({
    jql: z
      .string()
      .min(1)
      .describe('JQL, e.g. assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC.'),
    maxResults: z.number().int().min(1).max(AGENT_SEARCH_MAX).default(20),
  });

  async function runSearch(jql: string, maxResults: number, scope: string): Promise<ToolResult> {
    try {
      const { issues, nextPageToken } = await (await client()).search(jql, { maxResults });
      return [
        scope,
        issues.length === 0 ? "No issues matched." : "KEY\tTYPE\tSTATUS\tPRIORITY\tASSIGNEE\tSUMMARY",
        ...issues.map(formatIssueRow),
        nextPageToken === null ? "" : "(more results exist; narrow the JQL or raise maxResults)",
      ]
        .filter((line) => line !== "")
        .join("\n");
    } catch (error) {
      return toolError(error);
    }
  }

  function parseKey(raw: string): string {
    const key = normalizeIssueKey(raw);
    if (!isIssueKey(key)) throw new Error(`"${raw}" is not a Jira issue key such as PROJ-123.`);
    return key;
  }

  bb.agents.registerTool({
    name: "jira_search_issues",
    description:
      "Search Jira issues with JQL, limited to the Jira projects linked to this thread's BB project (unlimited when none are linked). Returns key, type, status, priority, assignee, and summary per issue. Read-only.",
    instructions:
      "Use jira_search_issues to find issues before asking the user for keys; use jira_get_issue for the description and comments. It only searches the Jira projects linked to this BB project — use jira_search_all_issues only when the user asks about issues outside them. Jira writes may pause for the user's approval.",
    presentation: { label: { pending: "Searching Jira", completed: "Searched Jira" } },
    parameters: searchParameters,
    async execute({ jql, maxResults }, ctx) {
      const keys = linkedKeys(ctx.projectId);
      return runSearch(scopeJql(jql, keys), maxResults, keys.length > 0 ? `Scope: linked Jira project(s) ${keys.join(", ")}.` : "Scope: all Jira projects (this BB project is not linked to any).");
    },
  });

  bb.agents.registerTool({
    name: "jira_search_all_issues",
    description:
      "Search Jira issues with JQL across every Jira project, ignoring this BB project's linked Jira projects. Read-only.",
    presentation: { label: { pending: "Searching all of Jira", completed: "Searched all of Jira" } },
    parameters: searchParameters,
    async execute({ jql, maxResults }) {
      return runSearch(jql.trim(), maxResults, "Scope: all Jira projects.");
    },
  });

  bb.agents.registerTool({
    name: "jira_get_issue",
    description:
      "Read one Jira issue: fields, description (Markdown), the latest comments, and the status transitions available now. Read-only.",
    presentation: { label: { pending: "Reading Jira issue", completed: "Read Jira issue" } },
    parameters: z.object({ key: keyParam }),
    async execute({ key }) {
      try {
        const detail = await loadIssueDetail(parseKey(key));
        return [
          formatIssue(detail.issue, detail.comments, detail.commentTotal),
          "",
          `Available transitions: ${
            detail.transitions.length === 0
              ? "none"
              : detail.transitions.map((t) => `${t.name} → ${t.toStatus}`).join(", ")
          }`,
        ].join("\n");
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_create_issue",
    description:
      "Create a Jira issue. Description is Markdown. May pause for the user's approval depending on the plugin's permission settings.",
    presentation: { label: { pending: "Creating Jira issue", completed: "Created Jira issue" } },
    parameters: z.object({
      projectKey: z
        .string()
        .default("")
        .describe("Project key, e.g. PROJ. Blank uses the Jira project linked to this BB project."),
      issueType: z.string().min(1).describe("Issue type name, e.g. Task, Bug, Story."),
      summary: z.string().min(1).max(255),
      description: z.string().default("").describe("Markdown body."),
      priority: z.string().default("").describe("Priority name, e.g. High. Blank keeps the default."),
      assignee: z
        .string()
        .default("")
        .describe('"me", a display name, or an email. Blank leaves it unassigned.'),
      parentKey: z.string().default("").describe("Parent issue key for a sub-task or child issue."),
    }),
    async execute(input, ctx) {
      try {
        const linked = linkedKeys(ctx.projectId);
        let projectKey = input.projectKey.trim().toUpperCase();
        if (projectKey.length === 0) {
          if (linked.length !== 1) {
            return toolError(
              linked.length === 0
                ? "Pass projectKey: this BB project is not linked to a Jira project."
                : `Pass projectKey: this BB project is linked to several Jira projects (${linked.join(", ")}).`,
            );
          }
          projectKey = linked[0] ?? "";
        }
        if (!isProjectKey(projectKey)) throw new Error(`"${input.projectKey}" is not a project key.`);
        const parentKey = input.parentKey.trim().length > 0 ? parseKey(input.parentKey) : "";
        const jira = await client();
        let assignee: JiraUser | null = null;
        if (input.assignee.trim().length > 0) {
          const lower = input.assignee.trim().toLowerCase();
          const resolved =
            lower === "me"
              ? { user: await jira.myself() }
              : matchUser(
                  await jira.findAssignableUsers({ projectKey }, input.assignee.trim()),
                  input.assignee,
                );
          if ("error" in resolved) return toolError(resolved.error);
          assignee = resolved.user;
        }
        const refusal = await authorizeAgentWrite(
          {
            action: "create",
            issueKey: projectKey,
            summary: `Create a ${input.issueType} in ${projectKey}: "${input.summary}"`,
            details: [
              { label: "Project", value: projectKey },
              { label: "Type", value: input.issueType },
              { label: "Summary", value: input.summary },
              ...(input.priority ? [{ label: "Priority", value: input.priority }] : []),
              ...(assignee ? [{ label: "Assignee", value: assignee.displayName }] : []),
              ...(parentKey ? [{ label: "Parent", value: parentKey }] : []),
              ...(input.description ? [{ label: "Description", value: input.description }] : []),
            ],
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        const created = await jira.createIssue({
          projectKey,
          issueType: input.issueType,
          summary: input.summary,
          ...(input.description.trim() ? { description: input.description } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(assignee ? { assigneeAccountId: assignee.accountId } : {}),
          ...(parentKey ? { parentKey } : {}),
        });
        published(created.key);
        return `Created ${created.key}: ${jira.siteUrl}/browse/${created.key}`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_update_issue",
    description:
      "Edit a Jira issue's summary, description (Markdown, replaces the whole description), priority, or labels (replaces the whole set). Use jira_transition_issue for status and jira_assign_issue for assignee. May pause for approval.",
    presentation: { label: { pending: "Editing Jira issue", completed: "Edited Jira issue" } },
    parameters: z.object({
      key: keyParam,
      summary: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      priority: z.string().min(1).optional(),
      labels: z.array(z.string().min(1)).optional(),
    }),
    async execute({ key: rawKey, ...fields }, ctx) {
      try {
        const key = parseKey(rawKey);
        const details = [
          ...(fields.summary !== undefined ? [{ label: "Summary", value: fields.summary }] : []),
          ...(fields.priority !== undefined ? [{ label: "Priority", value: fields.priority }] : []),
          ...(fields.labels !== undefined
            ? [{ label: "Labels", value: fields.labels.join(", ") || "(none)" }]
            : []),
          ...(fields.description !== undefined
            ? [{ label: "Description", value: fields.description || "(cleared)" }]
            : []),
        ];
        if (details.length === 0) return toolError("Nothing to change: pass at least one field.");
        const refusal = await authorizeAgentWrite(
          {
            action: "update",
            issueKey: key,
            summary: `Edit ${key}: ${details.map((detail) => detail.label.toLowerCase()).join(", ")}`,
            details,
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        await (await client()).updateIssue(key, fields);
        published(key);
        return `Updated ${key}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_transition_issue",
    description:
      "Move a Jira issue through its workflow, by transition name or target status name (e.g. \"In Progress\", \"Done\"). May pause for approval.",
    presentation: {
      label: { pending: "Changing Jira issue status", completed: "Changed Jira issue status" },
    },
    parameters: z.object({
      key: keyParam,
      to: z.string().min(1).describe("Transition name or target status name."),
    }),
    async execute({ key: rawKey, to }, ctx) {
      try {
        const key = parseKey(rawKey);
        const jira = await client();
        const [issue, transitions] = await Promise.all([
          jira.getIssue(key),
          jira.listTransitions(key),
        ]);
        const matched = matchTransition(transitions, to);
        if ("error" in matched) return toolError(matched.error);
        const refusal = await authorizeAgentWrite(
          {
            action: "transition",
            issueKey: key,
            summary: `Move ${key} from ${issue.status} to ${matched.transition.toStatus}`,
            details: [
              { label: "Issue", value: `${key} ${issue.summary}` },
              { label: "From", value: issue.status },
              { label: "To", value: matched.transition.toStatus },
            ],
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        await jira.transitionIssue(key, matched.transition.id);
        published(key);
        return `Moved ${key} to ${matched.transition.toStatus}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_add_comment",
    description: "Add a Markdown comment to a Jira issue. May pause for approval.",
    presentation: { label: { pending: "Commenting on Jira issue", completed: "Commented on Jira issue" } },
    parameters: z.object({ key: keyParam, body: z.string().min(1).describe("Markdown body.") }),
    async execute({ key: rawKey, body }, ctx) {
      try {
        const key = parseKey(rawKey);
        const refusal = await authorizeAgentWrite(
          {
            action: "comment",
            issueKey: key,
            summary: `Comment on ${key}`,
            details: [{ label: "Comment", value: body }],
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        await (await client()).addComment(key, body);
        published(key);
        return `Commented on ${key}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_assign_issue",
    description:
      'Assign a Jira issue to "me", a display name, or an email — or "unassigned" to clear it. May pause for approval.',
    presentation: { label: { pending: "Assigning Jira issue", completed: "Assigned Jira issue" } },
    parameters: z.object({
      key: keyParam,
      assignee: z.string().min(1).describe('"me", "unassigned", a display name, or an email.'),
    }),
    async execute({ key: rawKey, assignee }, ctx) {
      try {
        const key = parseKey(rawKey);
        const jira = await client();
        const resolved = await resolveAssignee(jira, key, assignee);
        if ("error" in resolved) return toolError(resolved.error);
        const issue = await jira.getIssue(key);
        const refusal = await authorizeAgentWrite(
          {
            action: "assign",
            issueKey: key,
            summary: `Assign ${key} to ${describeUser(resolved.user)}`,
            details: [
              { label: "Issue", value: `${key} ${issue.summary}` },
              { label: "From", value: describeUser(issue.assignee) },
              { label: "To", value: describeUser(resolved.user) },
            ],
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        await jira.assignIssue(key, resolved.user?.accountId ?? null);
        published(key);
        return `Assigned ${key} to ${describeUser(resolved.user)}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_delete_issue",
    description:
      "Permanently delete a Jira issue. This cannot be undone. May pause for approval.",
    instructions:
      "Only call jira_delete_issue when the user explicitly asked for the issue to be deleted; prefer a transition such as Done or Won't Do otherwise.",
    presentation: { label: { pending: "Deleting Jira issue", completed: "Deleted Jira issue" } },
    parameters: z.object({
      key: keyParam,
      deleteSubtasks: z.boolean().default(false).describe("Also delete its sub-tasks."),
    }),
    async execute({ key: rawKey, deleteSubtasks }, ctx) {
      try {
        const key = parseKey(rawKey);
        const jira = await client();
        const issue = await jira.getIssue(key);
        const refusal = await authorizeAgentWrite(
          {
            action: "delete",
            issueKey: key,
            summary: `Permanently delete ${key}${deleteSubtasks ? " and its sub-tasks" : ""}`,
            details: [
              { label: "Issue", value: `${key} ${issue.summary}` },
              { label: "Type", value: issue.issueType },
              { label: "Status", value: issue.status },
            ],
          },
          ctx,
        );
        if (refusal !== null) return toolError(refusal);
        await jira.deleteIssue(key, deleteSubtasks);
        await bb.storage.kv.delete(`threads:${key}`);
        published(key, true);
        return `Deleted ${key}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.contributeInstructions(({ projectId }) => {
    const keys = linkedKeys(projectId);
    if (keys.length === 0) return null;
    return `This BB project is linked to Jira project${keys.length === 1 ? "" : "s"} ${keys.join(", ")}. jira_search_issues and new issues default to ${keys.length === 1 ? "it" : "them"}; use jira_search_all_issues only when the user asks about other Jira projects.`;
  });

  // ------------------------------------------------------------------
  // @-mentions: attach an issue's current state to a message.
  // ------------------------------------------------------------------

  bb.ui.registerMentionProvider({
    id: "jira-issue",
    label: "Jira issues",
    async search({ query, projectId }) {
      try {
        const jira = await client();
        const keys = linkedKeys(projectId);
        if (keys.length > 0) {
          const { issues } = await jira.search(
            buildViewJql({ view: "all", projectKey: "", projectKeys: keys, text: query, includeDone: true }),
            { maxResults: 20 },
          );
          return issues.map((issue) => ({ id: issue.key, title: issue.key, subtitle: issue.summary }));
        }
        const picked = await jira.pickIssues(query);
        return picked.slice(0, 20).map((issue) => ({
          id: issue.key,
          title: issue.key,
          subtitle: issue.summary,
        }));
      } catch {
        return [];
      }
    },
    async resolve(itemId) {
      const jira = await client();
      const key = parseKey(itemId);
      const [issue, comments] = await Promise.all([jira.getIssue(key), jira.listComments(key)]);
      return { context: formatIssue(issue, comments.comments, comments.total) };
    },
  });
}
