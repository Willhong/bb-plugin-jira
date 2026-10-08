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
  const dependencyIssues: Record<string, unknown> = {};
  const issue = {
    id: "10001",
    key: "WEB-1",
    fields: {
      issuelinks: [] as unknown[],
      summary: "Fix login",
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { id: "10001", name: "Bug", subtask: false } as Record<string, unknown>,
      assignee: null,
      reporter: ME,
      project: { key: "WEB" },
    } as Record<string, unknown>,
  };
  const ISSUE_TYPES = [
    { id: "10001", name: "Bug", subtask: false },
    { id: "10002", name: "Task", subtask: false },
    { id: "10003", name: "Story", subtask: false },
    { id: "10005", name: "Sub-task", subtask: true },
  ];
  // `refuse`: Jira answers a type change with this field error. `ignore`:
  // Jira returns 204 but keeps the old type.
  const typeWorld: { refuse: string | null; ignore: boolean } = { refuse: null, ignore: false };
  // WEB-7..9: issues whose Blocks links live in `links`. `inwardIsBlocker`
  // decides how this fake Jira reads a create-link body.
  const BLOCKS = { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" };
  const linkWorld = { inwardIsBlocker: true, nextId: 500 };
  const links: Array<{ id: string; blocker: string; blocked: string }> = [];
  const linkedIssue = (key: string) => ({
    id: `id-${key}`,
    key,
    fields: {
      summary: `Task ${key}`,
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Task" },
      assignee: null,
      reporter: ME,
      project: { key: "WEB" },
      issuelinks: links.flatMap((link): unknown[] =>
        link.blocked === key
          ? [{ id: link.id, type: BLOCKS, inwardIssue: { key: link.blocker } }]
          : link.blocker === key
            ? [{ id: link.id, type: BLOCKS, outwardIssue: { key: link.blocked } }]
            : [],
      ),
    },
  });
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
      case "PUT /rest/api/3/issue/WEB-1": {
        const wanted = body?.fields?.issuetype as { id: string } | undefined;
        if (wanted !== undefined) {
          if (typeWorld.refuse !== null) return json({ errorMessages: [], errors: { issuetype: typeWorld.refuse } }, 400);
          if (!typeWorld.ignore) issue.fields.issuetype = ISSUE_TYPES.find((type) => type.id === wanted.id)!;
        }
        return new Response(null, { status: 204 });
      }
      case "GET /rest/api/3/project/WEB":
        return json({ id: "1", key: "WEB", issueTypes: ISSUE_TYPES });
      case "GET /rest/api/3/issue/WEB-1/transitions":
        return json({
          transitions: [
            { id: "21", name: "Start work", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        });
      case "POST /rest/api/3/issue/WEB-1/transitions":
        return new Response(null, { status: 204 });
      case "GET /rest/api/3/issue/WEB-1/comment":
        return json({ comments: [], total: 0 });
      case "POST /rest/api/3/issue/WEB-1/comment":
        return json({ id: "c1", author: ME, body: body?.body, created: "2026-09-17T00:00:00.000Z" }, 201);
      case "GET /rest/api/3/issue/WEB-1/comment/10001":
        return json({ id: "10001", author: ME, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "old text" }] }] }, created: "2026-09-17T00:00:00.000Z" });
      case "PUT /rest/api/3/issue/WEB-1/comment/10001":
        return json({ id: "10001", author: ME, body: body?.body, created: "2026-09-17T00:00:00.000Z" });
      case "DELETE /rest/api/3/issue/WEB-1/comment/10001":
        return new Response(null, { status: 204 });
      case "DELETE /rest/api/3/issue/WEB-1":
        return new Response(null, { status: 204 });
      case "GET /rest/api/3/project/WEB/statuses":
        return json([
          { statuses: [{ name: "To Do", statusCategory: { key: "new" } }, { name: "Done", statusCategory: { key: "done" } }] },
          { statuses: [{ name: "Done", statusCategory: { key: "done" } }] },
        ]);
      case "POST /rest/api/3/search/jql":
        return json({ issues: [issue], isLast: true });
      case "GET /rest/agile/1.0/board":
        return json({
          values: [
            { id: 7, name: "WEB board", type: "scrum" },
            { id: 8, name: "WEB kanban", type: "kanban" },
          ],
          isLast: true,
        });
      case "GET /rest/agile/1.0/board/7/sprint":
        return json({
          values: [
            { id: 41, name: "WEB Sprint 4", state: "active", originBoardId: 7, startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-14T00:00:00.000Z" },
            { id: 42, name: "WEB Sprint 5", state: "future", originBoardId: 7 },
          ].filter((sprint) => (parsed.searchParams.get("state") ?? "").split(",").includes(sprint.state)),
          isLast: true,
        });
      case "GET /rest/agile/1.0/issue/WEB-1":
        return json({ key: "WEB-1", fields: { sprint: { id: 41, name: "WEB Sprint 4", state: "active", originBoardId: 7 } } });
      case "GET /rest/agile/1.0/sprint/40":
        return json({ id: 40, name: "WEB Sprint 3", state: "closed", originBoardId: 7 });
      case "POST /rest/agile/1.0/sprint/41/issue":
      case "POST /rest/agile/1.0/sprint/42/issue":
      case "POST /rest/agile/1.0/backlog/issue":
        return new Response(null, { status: 204 });
      case "GET /rest/api/3/issueLinkType":
        return json({ issueLinkTypes: [{ id: "10003", name: "Relates", inward: "relates to", outward: "relates to" }, BLOCKS] });
      case "POST /rest/api/3/issueLink": {
        const [blocker, blocked] = linkWorld.inwardIsBlocker
          ? [body.inwardIssue.key, body.outwardIssue.key]
          : [body.outwardIssue.key, body.inwardIssue.key];
        links.push({ id: String(linkWorld.nextId++), blocker, blocked });
        return new Response(null, { status: 201 });
      }
      default: {
        const linked = /^\/rest\/api\/3\/issue\/(WEB-[789])$/.exec(parsed.pathname);
        if (method === "GET" && linked !== null) return json(linkedIssue(linked[1]!));
        const unlink = /^\/rest\/api\/3\/issueLink\/(\d+)$/.exec(parsed.pathname);
        if (method === "DELETE" && unlink !== null) {
          links.splice(links.findIndex((link) => link.id === unlink[1]), 1);
          return new Response(null, { status: 204 });
        }
        if (method === "GET" && dependencyIssues[parsed.pathname]) return json(dependencyIssues[parsed.pathname]);
        return json({ errorMessages: [`unexpected ${route}`] }, 404);
      }
    }
  });
  const writes = () => calls.filter((call) => call.method !== "GET" && call.path !== "/rest/api/3/search/jql");
  return { calls, writes, fetchImpl, issue, dependencyIssues, links, linkWorld, typeWorld };
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

describe("dependency reads", () => {
  it("keeps Blocks direction, resolves current cross-project states, and deduplicates", async () => {
    const type = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
    jira.issue.fields.issuelinks = [
      { type, inwardIssue: { key: "API-2", fields: { status: { name: "Stale snapshot" } } } },
      { type, outwardIssue: { key: "WEB-3" } },
      { type, inwardIssue: { key: "API-2" } },
      { type: { name: "Relates", inward: "relates to", outward: "relates to" }, inwardIssue: { key: "WEB-99" } },
      { type: { name: "Duplicate", inward: "is duplicated by", outward: "duplicates" }, outwardIssue: { key: "WEB-98" } },
    ];
    jira.dependencyIssues["/rest/api/3/issue/API-2"] = {
      id: "10002", key: "API-2", fields: { summary: "Server shipped", project: { key: "API" }, status: { name: "Done", statusCategory: { key: "done" } } },
    };
    jira.dependencyIssues["/rest/api/3/issue/WEB-3"] = {
      id: "10003", key: "WEB-3", fields: { summary: "Client waits", project: { key: "WEB" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
    };
    const harness = await load();
    const result = await harness.callRpc("getDependencies", { key: "web-1" });
    expect(result).toEqual({
      key: "WEB-1",
      blockedBy: [{ id: "10002", key: "API-2", projectKey: "API", title: "Server shipped", url: `${SITE}/browse/API-2`, status: "Done", statusCategory: "done" }],
      blocking: [{ id: "10003", key: "WEB-3", projectKey: "WEB", title: "Client waits", url: `${SITE}/browse/WEB-3`, status: "In Progress", statusCategory: "inprogress" }],
    });
    expect(jira.calls.filter((call) => call.path === "/rest/api/3/issue/API-2")).toHaveLength(1);
    expect(JSON.parse(await harness.callAgentTool("jira_get_dependencies", { key: "WEB-1" }) as string)).toEqual(result);
    expect(jira.writes()).toEqual([]);
    expect(harness.pendingInteractions).toHaveLength(0);
  });

  it("returns a valid empty graph and rejects missing links or unreadable prerequisites", async () => {
    const harness = await load();
    expect(await harness.callRpc("getDependencies", { key: "WEB-1" })).toEqual({ key: "WEB-1", blockedBy: [], blocking: [] });
    jira.issue.fields.issuelinks = undefined as never;
    await expect(harness.callRpc("getDependencies", { key: "WEB-1" })).rejects.toThrow();
    jira.issue.fields.issuelinks = [{ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "API-2" } }];
    await expect(harness.callRpc("getDependencies", { key: "WEB-1" })).rejects.toThrow();
    expect(jira.writes()).toEqual([]);
  });

  it("recognizes standard labels after a type rename, but refuses malformed directions and oversized graphs", async () => {
    const harness = await load();
    const type = { name: "Dependency", inward: "is blocked by", outward: "blocks" };
    jira.issue.fields.issuelinks = [{ type, inwardIssue: { key: "API-2" } }];
    jira.dependencyIssues["/rest/api/3/issue/API-2"] = {
      id: "10002", key: "API-2", fields: { summary: "Prerequisite", project: { key: "API" }, status: { name: "Todo", statusCategory: { key: "new" } } },
    };
    expect(await harness.callRpc("getDependencies", { key: "WEB-1" })).toMatchObject({ blockedBy: [{ key: "API-2", statusCategory: "todo" }] });
    jira.issue.fields.issuelinks = [{ type, inwardIssue: { key: "API-2" }, outwardIssue: { key: "WEB-3" } }];
    await expect(harness.callRpc("getDependencies", { key: "WEB-1" })).rejects.toThrow();
    jira.issue.fields.issuelinks = Array.from({ length: 101 }, (_, i) => ({ type, inwardIssue: { key: `API-${i + 1}` } }));
    await expect(harness.callRpc("getDependencies", { key: "WEB-1" })).rejects.toThrow(/Too many Jira dependencies/);
  });
});

describe("dependency writes", () => {
  const blocks = () => jira.links.map((link) => `${link.blocker}>${link.blocked}`).sort();

  it("asks with both directions spelled out, writes after approval, and returns the new graph", async () => {
    const harness = await load();
    const pending = harness.callAgentTool("jira_update_dependencies", { key: "web-7", addBlockedBy: ["WEB-8"], addBlocking: ["web-9"] });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({
      action: "update",
      issueKey: "WEB-7",
      summary: "Edit WEB-7: dependencies",
      details: [
        { label: "Issue", value: "WEB-7" },
        { label: "Blocked by +", value: "WEB-8 Task WEB-8" },
        { label: "Blocking +", value: "WEB-9 Task WEB-9" },
      ],
    });
    expect(jira.writes()).toEqual([]);

    harness.submitInteraction(prompt.id, "once");
    expect(JSON.parse((await pending) as string)).toMatchObject({
      key: "WEB-7",
      blockedBy: [{ key: "WEB-8", statusCategory: "todo" }],
      blocking: [{ key: "WEB-9" }],
    });
    expect(blocks()).toEqual(["WEB-7>WEB-9", "WEB-8>WEB-7"]);
    for (const key of ["WEB-7", "WEB-8", "WEB-9"]) {
      expect(harness.realtimeSignals).toContainEqual({ channel: "issue-changed", payload: { key, deleted: false } });
    }
  });

  it("follows whichever way Jira reads a new link, and never leaves a wrong-way link", async () => {
    const harness = await load({ ...CONFIGURED, allow_update: PERMISSION_ALWAYS });
    for (const inwardIsBlocker of [false, true]) {
      jira.linkWorld.inwardIsBlocker = inwardIsBlocker;
      jira.links.length = 0;
      await harness.callRpc("updateDependencies", { key: "WEB-7", addBlockedBy: ["WEB-8"] });
      expect(blocks()).toEqual(["WEB-8>WEB-7"]);
      // Learned: the next link is right the first time.
      const posts = () => jira.writes().filter((call) => call.path === "/rest/api/3/issueLink").length;
      const before = posts();
      await harness.callAgentTool("jira_update_dependencies", { key: "WEB-9", addBlocking: ["WEB-7"] });
      expect(posts() - before).toBe(1);
      expect(blocks()).toEqual(["WEB-8>WEB-7", "WEB-9>WEB-7"]);
    }
  });

  it("removes from the page without a prompt, in either direction", async () => {
    jira.links.push({ id: "1", blocker: "WEB-8", blocked: "WEB-7" }, { id: "2", blocker: "WEB-7", blocked: "WEB-9" });
    const harness = await load();
    expect(await harness.callRpc("updateDependencies", { key: "WEB-7", remove: ["WEB-8", "WEB-9"] }))
      .toEqual({ key: "WEB-7", blockedBy: [], blocking: [] });
    expect(jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /rest/api/3/issueLink/1",
      "DELETE /rest/api/3/issueLink/2",
    ]);
    expect(harness.pendingInteractions).toEqual([]);
  });

  it("treats an existing dependency as done, without asking or writing", async () => {
    jira.links.push({ id: "1", blocker: "WEB-8", blocked: "WEB-7" });
    const harness = await load();
    const result = await harness.callAgentTool("jira_update_dependencies", { key: "WEB-7", addBlockedBy: ["WEB-8"] });
    expect(JSON.parse(result as string)).toMatchObject({ blockedBy: [{ key: "WEB-8" }] });
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toEqual([]);
  });

  it("refuses self, reversed, missing, and doubled changes before asking", async () => {
    jira.links.push({ id: "1", blocker: "WEB-7", blocked: "WEB-8" });
    const harness = await load();
    const attempt = async (changes: Record<string, string[]>) =>
      JSON.stringify(await harness.callAgentTool("jira_update_dependencies", { key: "WEB-7", ...changes }));
    expect(await attempt({ addBlockedBy: ["WEB-7"] })).toContain("cannot depend on itself");
    expect(await attempt({ addBlockedBy: ["WEB-8"] })).toContain("already blocks WEB-8");
    expect(await attempt({ addBlocking: ["WEB-9"], remove: ["WEB-9"] })).toContain("in both addBlocking and remove");
    expect(await attempt({ remove: ["WEB-9"] })).toContain("neither blocks nor is blocked by");
    expect(await attempt({})).toContain("Nothing to change");
    expect(await attempt({ addBlocking: ["WEB-404"] })).toContain("404");
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toEqual([]);
  });

  it("sends nothing when the user declines", async () => {
    const harness = await load();
    const pending = harness.callAgentTool("jira_update_dependencies", { key: "WEB-7", addBlocking: ["WEB-8"] });
    harness.cancelInteraction((await waitFor(() => harness.pendingInteractions[0])).id);
    expect(await pending).toMatchObject({ isError: true });
    expect(jira.writes()).toEqual([]);
  });
});

describe("sub-tasks and parents", () => {
  it("puts the parent key on search rows, for the panel rpc and the agent table", async () => {
    jira.issue.fields.issuetype = { id: "10005", name: "Sub-task", subtask: true };
    jira.issue.fields.parent = { key: "WEB-0", fields: { summary: "Login epic" } };
    const harness = await load();
    const page = (await harness.callRpc("search", {
      view: "all",
      text: "",
      includeDone: true,
      jql: "",
    })) as { issues: Array<{ key: string; subtask: boolean; parentKey: string | null }> };
    expect(page.issues[0]).toMatchObject({ key: "WEB-1", subtask: true, parentKey: "WEB-0" });
    const search = jira.calls.find((call) => call.path === "/rest/api/3/search/jql");
    expect((search?.body as { fields: string[] }).fields).toContain("parent");
    expect((search?.body as { fields: string[] }).fields).not.toContain("subtasks");

    const table = String(await harness.callAgentTool("jira_search_all_issues", { jql: "project = WEB" }));
    expect(table).toContain("KEY\tTYPE\tPARENT\tSTATUS");
    expect(table).toContain("WEB-1\tSub-task\tWEB-0\tTo Do");
  });

  it("leaves parentKey null for an issue without a parent", async () => {
    const harness = await load();
    const page = (await harness.callRpc("search", { view: "all", text: "", includeDone: true, jql: "" })) as {
      issues: Array<{ parentKey: string | null }>;
    };
    expect(page.issues[0]?.parentKey).toBeNull();
  });

  it("lists an issue's sub-tasks in Jira's order", async () => {
    jira.issue.fields.subtasks = [
      { id: "2", key: "WEB-3", fields: { summary: "Second step", status: { name: "Done", statusCategory: { key: "done" } } } },
      { id: "1", key: "WEB-2", fields: { summary: "First step", status: { name: "To Do", statusCategory: { key: "new" } } } },
    ];
    const harness = await load();
    const detail = (await harness.callRpc("getIssue", { key: "WEB-1" })) as {
      issue: { subtasks: Array<{ key: string; summary: string; status: string; statusCategory: string }> };
    };
    expect(detail.issue.subtasks).toEqual([
      { key: "WEB-3", summary: "Second step", status: "Done", statusCategory: "done" },
      { key: "WEB-2", summary: "First step", status: "To Do", statusCategory: "todo" },
    ]);
    const text = String(await harness.callAgentTool("jira_get_issue", { key: "WEB-1" }));
    expect(text).toContain("Sub-tasks (2):\n- WEB-3 [Done] Second step\n- WEB-2 [To Do] First step");
  });

  it("gives an issue without sub-tasks an empty list", async () => {
    const harness = await load();
    const detail = (await harness.callRpc("getIssue", { key: "WEB-1" })) as { issue: { subtasks: unknown[] } };
    expect(detail.issue.subtasks).toEqual([]);
  });
});

describe("issue type changes", () => {
  const allowed = { ...CONFIGURED, allow_update: PERMISSION_ALWAYS };
  const puts = () => jira.writes().filter((call) => call.method === "PUT");

  it("asks first, changes the type by id on its own, then writes the other fields", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "story", labels: ["split"] });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({
      action: "update",
      details: [{ label: "Type", value: "story" }, { label: "Labels", value: "split" }],
    });
    expect(jira.writes()).toEqual([]);

    harness.submitInteraction(prompt.id, "once");
    expect(await result).toBe("Updated WEB-1.");
    expect(puts().map((call) => call.body)).toEqual([
      { fields: { issuetype: { id: "10003" } } },
      { fields: { labels: ["split"] } },
    ]);
    expect(jira.issue.fields.issuetype).toMatchObject({ name: "Story" });
  });

  it("changes the type from the panel rpc too", async () => {
    const harness = await load();
    await harness.callRpc("updateIssue", { key: "WEB-1", issueType: "Task" });
    expect(puts().map((call) => call.body)).toEqual([{ fields: { issuetype: { id: "10002" } } }]);
  });

  it("writes nothing when the issue already has that type", async () => {
    const harness = await load(allowed);
    expect(await harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "Bug" })).toBe("Updated WEB-1.");
    expect(puts()).toEqual([]);
  });

  it("names the project's types when the type does not exist", async () => {
    const harness = await load(allowed);
    const result = await harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "Epic", summary: "x" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('WEB has no issue type \\"Epic\\". Available: Bug, Task, Story, Sub-task.');
    expect(puts()).toEqual([]);
  });

  it("refuses a sub-task to standard change before writing", async () => {
    jira.issue.fields.issuetype = { id: "10005", name: "Sub-task", subtask: true };
    const harness = await load(allowed);
    const result = await harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "Story" });
    expect(JSON.stringify(result)).toContain("one is a sub-task type and the other is not");
    expect(puts()).toEqual([]);
  });

  it("returns Jira's reason when it refuses, and leaves the other fields unwritten", async () => {
    jira.typeWorld.refuse = "The issue type selected is invalid.";
    const harness = await load(allowed);
    const result = await harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "Story", summary: "New" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(
      "Jira refused to change WEB-1 to Story (Jira responded 400: issuetype: The issue type selected is invalid.)",
    );
    expect(puts()).toHaveLength(1);
  });

  it("fails when Jira accepts the edit but keeps the old type", async () => {
    jira.typeWorld.ignore = true;
    const harness = await load(allowed);
    const result = await harness.callAgentTool("jira_update_issue", { key: "WEB-1", issueType: "Story" });
    expect(JSON.stringify(result)).toContain("Jira accepted the edit but WEB-1 is still Bug, not Story.");
  });
});

describe("comment edit and delete", () => {
  it("edits a comment only after approval, showing the current and new body", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_update_comment", { key: "WEB-1", commentId: "10001", body: "new **text**" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({
      action: "comment",
      issueKey: "WEB-1",
      details: [
        { label: "Author", value: expect.any(String) },
        { label: "Current", value: "old text" },
        { label: "New", value: "new **text**" },
      ],
    });
    expect(jira.writes()).toEqual([]);
    harness.submitInteraction(prompt.id, "once");
    expect(await result).toBe("Edited comment 10001 on WEB-1.");
    expect(jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /rest/api/3/issue/WEB-1/comment/10001",
    ]);
  });

  it("gates comment deletes on the delete policy, not the comment policy", async () => {
    const harness = await load({ ...CONFIGURED, allow_comment: "Always allow" });
    const result = harness.callAgentTool("jira_delete_comment", { key: "WEB-1", commentId: "10001" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({ action: "delete", issueKey: "WEB-1" });
    harness.submitInteraction(prompt.id, "once");
    expect(await result).toBe("Deleted comment 10001 on WEB-1.");
    expect(jira.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /rest/api/3/issue/WEB-1/comment/10001",
    ]);
  });

  it("rejects a non-numeric comment id before calling Jira", async () => {
    const harness = await load();
    await expect(
      harness.callAgentTool("jira_delete_comment", { key: "WEB-1", commentId: "../x" }),
    ).rejects.toThrow(/comment id/i);
    expect(jira.writes()).toEqual([]);
  });
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
    expect(await result).toBe("Commented on WEB-1 (comment c1).");
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
      "Commented on WEB-1 (comment c1).",
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

  it("leaves the agent to the project's defaults unless one is picked", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-web" });
    const [spawn] = harness.sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
    expect(spawn).not.toHaveProperty("providerId");
    expect(spawn).not.toHaveProperty("model");
  });

  it("runs the picked agent, marked as the user's own choice", async () => {
    const harness = await loadWithProjects();
    await harness.callRpc("sendToAgent", {
      key: "WEB-1",
      bbProjectId: "proj-web",
      execution: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "fast" },
    });
    const [spawn] = harness.sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
    expect(spawn).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      serviceTier: "fast",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      },
    });
  });

  it("refuses a malformed agent pick without spawning", async () => {
    const harness = await loadWithProjects();
    await expect(
      harness.callRpc("sendToAgent", {
        key: "WEB-1",
        bbProjectId: "proj-web",
        execution: { providerId: "claude-code", model: "", reasoningLevel: "high" },
      }),
    ).rejects.toThrow();
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("starts the model picker on the project's defaults", async () => {
    const harness = await loadWithProjects();
    harness.sdk.stub("projects.defaultExecutionOptions", async () => ({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "auto",
    }));
    expect(await harness.callRpc("executionDefaults", { bbProjectId: "proj-web" })).toEqual({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      serviceTier: "default",
    });
    // No defaults, or none readable, leaves the picker to bb's own default.
    harness.sdk.stub("projects.defaultExecutionOptions", async () => null);
    expect(await harness.callRpc("executionDefaults", { bbProjectId: "proj-web" })).toBeNull();
    harness.sdk.stub("projects.defaultExecutionOptions", async () => {
      throw new Error("offline");
    });
    expect(await harness.callRpc("executionDefaults", { bbProjectId: "proj-web" })).toBeNull();
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

// A done issue has no more work in it, so the threads "Send to agent" started
// for it are filed away on BB Sidebar's settled shelf. Sidebar is optional:
// every failure here leaves the transition itself alone.
describe("settling threads when an issue is done", () => {
  async function loadWithThread(settings: Record<string, string | boolean> = {}) {
    const host = createFakePluginHost({
      pluginId: "jira",
      settings: { ...CONFIGURED, ...settings },
      sdk: {
        hosts: { list: async () => [makeHostResponse({ id: "host-laptop", name: "laptop", status: "connected" })] },
        projects: {
          list: async () => [
            { id: "proj-web", name: "web-app", sources: [{ hostId: "host-laptop", isDefault: true, path: "/src/web" }] },
          ],
        },
        threads: { spawn: async () => ({ id: "thr-web-1" }) },
        plugins: { callRpc: async () => ({ ok: true }) },
      },
    } as Parameters<typeof createFakePluginHost>[0]);
    await plugin(host.bb);
    jira.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/rest/api/3/issue/WEB-1/comment") return new Response(JSON.stringify({ comments: [], total: 0 }));
      return fakeJira().fetchImpl(url, init);
    });
    await host.harness.callRpc("sendToAgent", { key: "WEB-1", bbProjectId: "proj-web" });
    return host.harness;
  }

  const settleCalls = (harness: Awaited<ReturnType<typeof loadWithThread>>) =>
    harness.sdk.callsTo("plugins.callRpc").map(([args]) => {
      const call = args as { pluginId: string; method: string; input: unknown };
      return { pluginId: call.pluginId, method: call.method, input: call.input };
    });

  it("settles the issue's threads once it moves to a done status", async () => {
    const harness = await loadWithThread();
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" });
    expect(settleCalls(harness)).toEqual([
      { pluginId: "bb-sidebar", method: "settle", input: { threadId: "thr-web-1" } },
    ]);
  });

  it("leaves a thread alone for a transition that is not done", async () => {
    const harness = await loadWithThread();
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "In Progress" });
    expect(settleCalls(harness)).toEqual([]);
  });

  it("settles each thread once, so a later transition cannot overrule the user", async () => {
    const harness = await loadWithThread();
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" });
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" });
    expect(settleCalls(harness)).toHaveLength(1);
  });

  it("re-reads the issue when the caller only names a transition id", async () => {
    const harness = await loadWithThread();
    // The board hands over a bare transition id, so the new status is only
    // knowable from the issue itself.
    let moved = false;
    jira.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      if (method === "POST" && path.endsWith("/transitions")) {
        moved = true;
        return new Response(null, { status: 204 });
      }
      if (moved && path === "/rest/api/3/issue/WEB-1") {
        return new Response(
          JSON.stringify({
            id: "10001",
            key: "WEB-1",
            fields: {
              summary: "Fix login",
              status: { name: "Done", statusCategory: { key: "done" } },
              issuetype: { name: "Bug" },
              assignee: null,
              reporter: ME,
              project: { key: "WEB" },
            },
          }),
        );
      }
      return fakeJira().fetchImpl(url, init);
    });

    await harness.callRpc("transitionIssue", { key: "WEB-1", transitionId: "31" });
    expect(settleCalls(harness)).toEqual([
      { pluginId: "bb-sidebar", method: "settle", input: { threadId: "thr-web-1" } },
    ]);
  });

  it("respects the setting", async () => {
    const harness = await loadWithThread({ settle_on_done: false });
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" });
    expect(settleCalls(harness)).toEqual([]);
  });

  it("completes the transition when BB Sidebar is not installed", async () => {
    const harness = await loadWithThread();
    harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("plugin bb-sidebar is not installed");
    });
    expect(await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" })).toEqual({ ok: true });
    expect(harness.logEntries.some((entry) => entry.message.includes("Could not settle thr-web-1"))).toBe(true);
    // Unsettled, so a later transition tries again.
    harness.sdk.stub("plugins.callRpc", async () => ({ ok: true }));
    await harness.callRpc("moveIssue", { key: "WEB-1", toStatus: "Done" });
    expect(settleCalls(harness)).toHaveLength(2);
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

describe("sprints", () => {
  it("lists active and future sprints of scrum boards only", async () => {
    const harness = await load();
    const result = await harness.callAgentTool("jira_list_sprints", { projectKey: "WEB" });
    expect(result).toContain("41\tactive\t7\tWEB Sprint 4\t2026-10-01 → 2026-10-14");
    expect(result).toContain("42\tfuture\t7\tWEB Sprint 5");
    expect(jira.calls.some((call) => call.path === "/rest/agile/1.0/board/8/sprint")).toBe(false);
  });

  it("moves issues into the active sprint only after approval", async () => {
    const harness = await load();
    const result = harness.callAgentTool("jira_move_to_sprint", { keys: ["WEB-1"], sprint: "active" });
    const prompt = await waitFor(() => harness.pendingInteractions[0]);
    expect(prompt.payload).toMatchObject({
      action: "sprint",
      issueKey: "WEB-1",
      details: [{ label: "To", value: 'sprint 41 "WEB Sprint 4" (active)' }, { label: "WEB-1", value: "Fix login" }],
    });
    expect(jira.writes()).toEqual([]);
    harness.submitInteraction(prompt.id, "once");
    expect(await result).toBe('Moved WEB-1 to sprint 41 "WEB Sprint 4" (active).');
    expect(jira.writes()).toEqual([
      { method: "POST", path: "/rest/agile/1.0/sprint/41/issue", body: { issues: ["WEB-1"] } },
    ]);
  });

  it("resolves a sprint by exact name and moves to the backlog", async () => {
    const harness = await load({ ...CONFIGURED, allow_sprint: PERMISSION_ALWAYS });
    expect(await harness.callAgentTool("jira_move_to_sprint", { keys: ["WEB-1"], sprint: "web sprint 5" })).toBe(
      'Moved WEB-1 to sprint 42 "WEB Sprint 5" (future).',
    );
    expect(await harness.callAgentTool("jira_move_to_sprint", { keys: ["WEB-1"], sprint: "backlog" })).toBe(
      "Moved WEB-1 to the backlog.",
    );
    expect(jira.writes().map((call) => call.path)).toEqual([
      "/rest/agile/1.0/sprint/42/issue",
      "/rest/agile/1.0/backlog/issue",
    ]);
  });

  it("refuses an unknown name or a closed sprint without writing", async () => {
    const harness = await load({ ...CONFIGURED, allow_sprint: PERMISSION_ALWAYS });
    const unknown = await harness.callAgentTool("jira_move_to_sprint", { keys: ["WEB-1"], sprint: "Sprint 9" });
    expect(JSON.stringify(unknown)).toContain('No open sprint matches \\"Sprint 9\\"');
    const closed = await harness.callAgentTool("jira_move_to_sprint", { keys: ["WEB-1"], sprint: "40" });
    expect(JSON.stringify(closed)).toContain("is closed");
    expect(jira.writes()).toEqual([]);
  });
});

describe("sprint rpc for the issue view", () => {
  it("returns the current sprint and the open sprints", async () => {
    const harness = await load();
    const result = (await harness.callRpc("issueSprints", { key: "WEB-1" })) as {
      current: { id: number } | null;
      options: Array<{ id: number }>;
    };
    expect(result.current?.id).toBe(41);
    expect(result.options.map((sprint) => sprint.id)).toEqual([41, 42]);
  });

  it("moves the issue to a sprint or the backlog without asking (the user's own action)", async () => {
    const harness = await load();
    await harness.callRpc("moveToSprint", { key: "WEB-1", sprintId: 42 });
    await harness.callRpc("moveToSprint", { key: "WEB-1", sprintId: null });
    expect(harness.pendingInteractions).toEqual([]);
    expect(jira.writes()).toEqual([
      { method: "POST", path: "/rest/agile/1.0/sprint/42/issue", body: { issues: ["WEB-1"] } },
      { method: "POST", path: "/rest/agile/1.0/backlog/issue", body: { issues: ["WEB-1"] } },
    ]);
  });
});
