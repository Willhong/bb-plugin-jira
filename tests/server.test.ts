// The plugin loaded into BB's fake host, against a fake Jira. These cover the
// agent write gate: nothing reaches Jira before approval, a refusal writes
// nothing, "Always allow" persists, and each action's policy is independent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { matchTransition, matchUser } from "../server";
import { PERMISSION_ALWAYS } from "../jira";

const SITE = "https://acme.atlassian.net";
const CONFIGURED = { siteUrl: "acme", email: "me@acme.dev", apiToken: "tok" };
const ME = { accountId: "u-me", displayName: "Kim Dev", emailAddress: "me@acme.dev" };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeJira() {
  const calls: Call[] = [];
  const issue = {
    id: "10001",
    key: "WEB-1",
    fields: {
      summary: "Fix login",
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Bug" },
      assignee: null,
      reporter: ME,
      project: { key: "WEB" },
    },
  };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: parsed.pathname, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    const route = `${method} ${parsed.pathname}`;
    switch (route) {
      case "GET /rest/api/3/myself":
        return json(ME);
      case "GET /rest/api/3/issue/WEB-1":
        return json(issue);
      case "GET /rest/api/3/issue/WEB-1/transitions":
        return json({
          transitions: [
            { id: "21", name: "Start work", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        });
      case "POST /rest/api/3/issue/WEB-1/transitions":
        return new Response(null, { status: 204 });
      case "POST /rest/api/3/issue/WEB-1/comment":
        return json({ id: "c1", author: ME, body: body?.body, created: "2026-09-17T00:00:00.000Z" }, 201);
      case "DELETE /rest/api/3/issue/WEB-1":
        return new Response(null, { status: 204 });
      case "GET /rest/api/3/project/WEB/statuses":
        return json([
          { statuses: [{ name: "To Do", statusCategory: { key: "new" } }, { name: "Done", statusCategory: { key: "done" } }] },
          { statuses: [{ name: "Done", statusCategory: { key: "done" } }] },
        ]);
      case "POST /rest/api/3/search/jql":
        return json({ issues: [issue], isLast: true });
      default:
        return json({ errorMessages: [`unexpected ${route}`] }, 404);
    }
  });
  const writes = () => calls.filter((call) => call.method !== "GET" && call.path !== "/rest/api/3/search/jql");
  return { calls, writes, fetchImpl };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

async function load(settings: Record<string, string> = CONFIGURED) {
  const host = createFakePluginHost({ pluginId: "jira", settings });
  await plugin(host.bb);
  return host.harness;
}

let jira: ReturnType<typeof fakeJira>;

beforeEach(() => {
  jira = fakeJira();
  vi.stubGlobal("fetch", jira.fetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent write gate", () => {
  it("asks before writing, and writes only after the user allows once", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_add_comment", { key: "web-1", body: "Looking into it" });

    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.rendererId).toBe("jira-approve-write");
    expect(prompt.payload).toMatchObject({
      action: "comment",
      issueKey: "WEB-1",
      details: [{ label: "Comment", value: "Looking into it" }],
    });
    expect(jira.writes()).toEqual([]);

    harness.submitInteraction(prompt.id, "once");
    expect(await result).toBe("Commented on WEB-1.");
    expect(jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /rest/api/3/issue/WEB-1/comment",
    ]);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "issue-changed",
      payload: { key: "WEB-1", deleted: false },
    });
  });

  it("sends nothing to Jira when the user declines", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_delete_issue", { key: "WEB-1" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    harness.cancelInteraction(prompt.id);

    expect(await result).toMatchObject({ isError: true });
    expect(jira.writes()).toEqual([]);
  });

  it("fails closed on an unexpected submitted value", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_add_comment", { key: "WEB-1", body: "x" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    harness.submitInteraction(prompt.id, true);

    expect(await result).toMatchObject({ isError: true });
    expect(jira.writes()).toEqual([]);
  });

  it("remembers Always allow for that action only", async () => {
    const harness = await load();
    const first = harness.callAgentTool("jira_add_comment", { key: "WEB-1", body: "one" });
    harness.submitInteraction((await waitFor(() => harness.pendingInteractions[0])).id, "always");
    await first;

    // Same action: no prompt this time.
    expect(await harness.callAgentTool("jira_add_comment", { key: "WEB-1", body: "two" })).toBe(
      "Commented on WEB-1.",
    );
    expect(await harness.callRpc("status", null)).toMatchObject({
      permissions: { comment: "always", delete: "ask", transition: "ask" },
    });

    // A different action still asks.
    const pendingTransition = harness.callAgentTool("jira_transition_issue", { key: "WEB-1", to: "done" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({ action: "transition", summary: "Move WEB-1 from To Do to Done" });
    harness.cancelInteraction(prompt.id);
    await pendingTransition;
    expect(jira.writes().filter((call) => call.path.endsWith("/transitions"))).toEqual([]);
  });

  it("skips the prompt when settings already allow the action", async () => {
    const harness = await load({ ...CONFIGURED, allow_transition: PERMISSION_ALWAYS });
    expect(await harness.callAgentTool("jira_transition_issue", { key: "WEB-1", to: "In Progress" })).toBe(
      "Moved WEB-1 to In Progress.",
    );
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toEqual([
      { method: "POST", path: "/rest/api/3/issue/WEB-1/transitions", body: { transition: { id: "21" } } },
    ]);
  });

  it("does not prompt for a transition that cannot be matched", async () => {
    const harness = await load();
    const result = await harness.callAgentTool("jira_transition_issue", { key: "WEB-1", to: "Shipped" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Start work → In Progress");
    expect(harness.pendingInteractions).toEqual([]);
  });
});

describe("panel rpc", () => {
  it("lets the user's own actions through without an agent prompt", async () => {
    const harness = await load();
    await harness.callRpc("transitionIssue", { key: "WEB-1", transitionId: "31" });
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toHaveLength(1);
  });

  it("searches with the view's JQL", async () => {
    const harness = await load();
    const page = (await harness.callRpc("search", {
      view: "assigned",
      projectKey: "web",
      text: "",
      includeDone: false,
      jql: "",
    })) as { issues: Array<{ key: string }>; jql: string };
    expect(page.issues.map((issue) => issue.key)).toEqual(["WEB-1"]);
    expect(page.jql).toBe(
      'project = "WEB" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    );
  });

  it("changes permissions from the panel", async () => {
    const harness = await load();
    await harness.callRpc("setPermissions", { permissions: { delete: "always" } });
    expect(await harness.callRpc("status", null)).toMatchObject({
      ready: true,
      user: { accountId: "u-me" },
      permissions: { delete: "always", comment: "ask" },
    });
  });
});

describe("board", () => {
  it("moves an issue by target status without an agent prompt", async () => {
    const harness = await load();
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "in progress" });
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toEqual([
      { method: "POST", path: "/rest/api/3/issue/WEB-1/transitions", body: { transition: { id: "21" } } },
    ]);
  });

  it("refuses a status the workflow cannot reach, writing nothing", async () => {
    const harness = await load();
    await expect(harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Blocked" })).rejects.toThrow(
      "can't move to Blocked",
    );
    expect(jira.writes()).toEqual([]);
  });

  it("does not match a transition by its name when moving to a status", async () => {
    // "Start work" is a transition name, not a status: a board column never names it.
    const harness = await load();
    await expect(harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Start work" })).rejects.toThrow();
    expect(jira.writes()).toEqual([]);
  });

  it("lists a project's statuses once each", async () => {
    const harness = await load();
    expect(await harness.callRpc("projectStatuses", { projectKey: "web" })).toEqual([
      { name: "To Do", category: "todo" },
      { name: "Done", category: "done" },
    ]);
  });

  it("passes the assignee filter into the search JQL", async () => {
    const harness = await load();
    const page = (await harness.callRpc("search", {
      view: "all",
      assignees: ["u-1"],
      unassigned: true,
    })) as { jql: string };
    expect(page.jql).toBe('(assignee in ("u-1") OR assignee is EMPTY) AND statusCategory != Done ORDER BY updated DESC');
  });
});

describe("project links", () => {
  function lastSearchJql(): string {
    const search = [...jira.calls].reverse().find((call) => call.path === "/rest/api/3/search/jql");
    return (search?.body as { jql: string }).jql;
  }

  it("scopes jira_search_issues to the thread's linked projects, but not the all-projects tool", async () => {
    const harness = await load();
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-a", jiraProjectKeys: ["web"] });

    const scoped = await harness.callAgentTool(
      "jira_search_issues",
      { jql: "project = OTHER OR assignee = currentUser() ORDER BY updated DESC" },
      { projectId: "proj-a" },
    );
    expect(lastSearchJql()).toBe(
      'project = "WEB" AND (project = OTHER OR assignee = currentUser()) ORDER BY updated DESC',
    );
    expect(scoped).toContain("Scope: linked Jira project(s) WEB.");

    await harness.callAgentTool("jira_search_all_issues", { jql: "assignee = currentUser()" }, { projectId: "proj-a" });
    expect(lastSearchJql()).toBe("assignee = currentUser()");

    // A thread in an unlinked BB project is not scoped.
    await harness.callAgentTool("jira_search_issues", { jql: "assignee = currentUser()" }, { projectId: "proj-b" });
    expect(lastSearchJql()).toBe("assignee = currentUser()");
  });

  it("tells agents about the link only in linked projects", async () => {
    const harness = await load();
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-a", jiraProjectKeys: ["WEB"] });
    const instructions = harness.registrations.instructionProvider;
    expect(instructions?.({ threadId: "t", projectId: "proj-a" })).toContain("linked to Jira project WEB");
    expect(instructions?.({ threadId: "t", projectId: "proj-b" })).toBeNull();
  });

  it("keeps links across a reload and removes a link set to no projects", async () => {
    const host = createFakePluginHost({ pluginId: "jira", settings: CONFIGURED });
    await plugin(host.bb);
    await host.harness.callRpc("setProjectLink", { bbProjectId: "proj-a", jiraProjectKeys: ["WEB", "APP"] });
    const reloaded = await host.harness.reload(plugin);
    expect(await reloaded.harness.callRpc("projectLink", { bbProjectId: "proj-a" })).toEqual({
      jiraProjectKeys: ["WEB", "APP"],
    });
    await reloaded.harness.callRpc("setProjectLink", { bbProjectId: "proj-a", jiraProjectKeys: [] });
    expect(await reloaded.harness.callRpc("projectLink", { bbProjectId: "proj-a" })).toEqual({ jiraProjectKeys: [] });
  });

  it("keeps the panel's project pick inside the linked scope, including custom JQL", async () => {
    const harness = await load();
    const search = async (input: Record<string, unknown>) =>
      ((await harness.callRpc("search", { view: "all", includeDone: true, ...input })) as { jql: string }).jql;
    expect(await search({ scopeKeys: ["WEB", "APP"] })).toBe('project in ("WEB", "APP") ORDER BY updated DESC');
    expect(await search({ scopeKeys: ["WEB", "APP"], projectKey: "APP" })).toBe('project = "APP" ORDER BY updated DESC');
    expect(await search({ scopeKeys: ["WEB"], projectKey: "OTHER" })).toBe('project = "WEB" ORDER BY updated DESC');
    expect(await search({ scopeKeys: ["WEB"], jql: "status = Done" })).toBe('project = "WEB" AND (status = Done)');
  });

  it("defaults a new issue to the single linked project", async () => {
    const harness = await load({ ...CONFIGURED, allow_create: PERMISSION_ALWAYS });
    const created: unknown[] = [];
    jira.fetchImpl.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      created.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ key: "WEB-9" }), { status: 201 });
    });
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-a", jiraProjectKeys: ["WEB"] });
    expect(
      await harness.callAgentTool("jira_create_issue", { issueType: "Task", summary: "New" }, { projectId: "proj-a" }),
    ).toContain("Created WEB-9");
    expect(created[0]).toMatchObject({ fields: { project: { key: "WEB" } } });

    const unlinked = await harness.callAgentTool(
      "jira_create_issue",
      { issueType: "Task", summary: "New" },
      { projectId: "proj-b" },
    );
    expect(unlinked).toMatchObject({ isError: true });
  });
});

describe("send to agent", () => {
  // Two enrolled daemons: the laptop is online and holds every checkout, the
  // desktop is offline and only has web-app.
  const source = (hostId: string, isDefault = false) => ({ hostId, isDefault, path: `/src/${hostId}` });

  async function loadWithProjects() {
    const host = createFakePluginHost({
      pluginId: "jira",
      settings: CONFIGURED,
      sdk: {
        hosts: {
          list: async () => [
            makeHostResponse({ id: "host-laptop", name: "laptop", status: "connected" }),
            makeHostResponse({ id: "host-desktop", name: "desktop", status: "disconnected" }),
          ],
        },
        projects: {
          list: async () => [
            { id: "proj-web", name: "web-app", sources: [source("host-desktop"), source("host-laptop", true)] },
            { id: "proj-api", name: "api", sources: [source("host-laptop", true)] },
            { id: "proj-misc", name: "misc", sources: [] },
          ],
        },
        threads: { spawn: async () => ({ id: "thr-new" }) },
      },
    } as Parameters<typeof createFakePluginHost>[0]);
    await plugin(host.bb);
    jira.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/rest/api/3/issue/WEB-1/comment") return new Response(JSON.stringify({ comments: [], total: 0 }));
      return fakeJira().fetchImpl(url, init);
    });
    return host.harness;
  }

  it("offers the BB projects linked to the issue's Jira project", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-api", jiraProjectKeys: ["WEB"] });
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-web", jiraProjectKeys: ["APP", "WEB"] });
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-misc", jiraProjectKeys: ["OPS"] });
    const laptop = { hostId: "host-laptop", name: "laptop", connected: true, isDefault: true };
    const desktop = { hostId: "host-desktop", name: "desktop", connected: false, isDefault: false };
    expect(await harness.callRpc("agentTargets", { key: "WEB-1" })).toEqual({
      jiraProjectKey: "WEB",
      linked: [
        { bbProjectId: "proj-api", name: "api", hosts: [laptop] },
        { bbProjectId: "proj-web", name: "web-app", hosts: [laptop, desktop] },
      ],
      all: [
        { bbProjectId: "proj-api", name: "api", hosts: [laptop] },
        { bbProjectId: "proj-misc", name: "misc", hosts: [] },
        { bbProjectId: "proj-web", name: "web-app", hosts: [laptop, desktop] },
      ],
    });
  });

  it("starts the thread in the chosen BB project", async () => {
    const harness = await loadWithProjects();
    expect(await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-api", note: "fix it" })).toEqual({
      threadId: "thr-new",
    });
    const [spawn] = harness.sdk.callsTo("threads.spawn")[0] as [{ projectId: string; prompt: string }];
    expect(spawn.projectId).toBe("proj-api");
    expect(spawn.prompt).toContain("fix it");
    // Not asked to link, so no link appears.
    expect(await harness.callRpc("projectLink", { bbProjectId: "proj-api" })).toEqual({ jiraProjectKeys: [] });
  });

  it("links the Jira project when asked, keeping existing links", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("setProjectLink", { bbProjectId: "proj-api", jiraProjectKeys: ["OPS"] });
    await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-api", linkProject: true });
    expect(await harness.callRpc("projectLink", { bbProjectId: "proj-api" })).toEqual({ jiraProjectKeys: ["OPS", "WEB"] });
  });

  it("works in the project's own checkout by default", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-web" });
    const [spawn] = harness.sdk.callsTo("threads.spawn")[0] as [{ environment: unknown }];
    expect(spawn.environment).toEqual({ type: "project-default" });
  });

  it("starts a new worktree when asked", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-web", worktree: true });
    const [spawn] = harness.sdk.callsTo("threads.spawn")[0] as [{ environment: unknown }];
    expect(spawn.environment).toEqual({
      type: "host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("runs on the chosen machine, in its checkout or in a worktree", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-web", hostId: "host-desktop" });
    await harness.callRpc("sendToAgent", {
      key: "WEB-1",
      bbProjectId: "proj-web",
      hostId: "host-desktop",
      worktree: true,
    });
    const environments = harness.sdk
      .callsTo("threads.spawn")
      .map(([spawn]) => (spawn as { environment: unknown }).environment);
    expect(environments).toEqual([
      { type: "host", hostId: "host-desktop", workspace: { type: "unmanaged", path: null } },
      {
        type: "host",
        hostId: "host-desktop",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
    ]);
  });

  it("refuses a machine the project is not checked out on", async () => {
    const harness = await loadWithProjects();
    await expect(
      harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-api", hostId: "host-desktop" }),
    ).rejects.toThrow("not checked out on that machine");
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("refuses an unknown BB project without spawning", async () => {
    const harness = await loadWithProjects();
    await expect(harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-gone" })).rejects.toThrow(
      "no longer exists",
    );
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });
});

describe("configuration", () => {
  it("reports missing credentials without calling Jira", async () => {
    const harness = await load({});
    expect(harness.needsConfigurationMessages[0]).toContain("No Jira site is set");
    expect(jira.calls).toEqual([]);
    expect(await harness.callRpc("status", null)).toMatchObject({ ready: false, configured: false });
  });
});

describe("matching helpers", () => {
  const users = [
    { accountId: "a", displayName: "Kim Dev", email: "kim@acme.dev" },
    { accountId: "b", displayName: "Kim Ops", email: "ops@acme.dev" },
  ];

  it("prefers an exact email or name, and explains ambiguity", () => {
    expect(matchUser(users, "OPS@acme.dev")).toEqual({ user: users[1] });
    expect(matchUser(users, "kim dev")).toEqual({ user: users[0] });
    expect(matchUser(users, "kim")).toMatchObject({ error: expect.stringContaining("several users") });
    expect(matchUser([], "nobody")).toMatchObject({ error: expect.stringContaining("No assignable") });
  });

  it("matches a transition by id, name, or target status", () => {
    const transitions = [{ id: "21", name: "Start work", toStatus: "In Progress" }];
    expect(matchTransition(transitions, "21")).toEqual({ transition: transitions[0] });
    expect(matchTransition(transitions, "start work")).toEqual({ transition: transitions[0] });
    expect(matchTransition(transitions, "in progress")).toEqual({ transition: transitions[0] });
  });
});
