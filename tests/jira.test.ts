import { describe, expect, it } from "vitest";
import {
  JiraClient,
  PERMISSION_ALWAYS,
  PERMISSION_ASK,
  buildViewJql,
  describeJiraError,
  isIssueKey,
  normalizeIssue,
  normalizeSiteUrl,
  requiresApproval,
  scopeJql,
} from "../jira";

describe("normalizeSiteUrl", () => {
  it("accepts a bare site name, a host, or a URL", () => {
    expect(normalizeSiteUrl("acme")).toBe("https://acme.atlassian.net");
    expect(normalizeSiteUrl("acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeSiteUrl("https://acme.atlassian.net/jira/software")).toBe("https://acme.atlassian.net");
  });

  it("refuses plain http and empty input", () => {
    expect(normalizeSiteUrl("http://acme.atlassian.net")).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();
  });
});

describe("issue keys", () => {
  it("matches PROJ-123 and nothing looser", () => {
    expect(isIssueKey("PROJ-123")).toBe(true);
    expect(isIssueKey("AB2_X-1")).toBe(true);
    expect(isIssueKey("proj-123")).toBe(false);
    expect(isIssueKey("PROJ-0")).toBe(false);
    expect(isIssueKey("PROJ-1/../x")).toBe(false);
  });
});

describe("buildViewJql", () => {
  it("combines view, project, open-only, and quoted text", () => {
    expect(
      buildViewJql({ view: "assigned", projectKey: "WEB", text: 'say "hi"', includeDone: false }),
    ).toBe(
      'project = "WEB" AND assignee = currentUser() AND statusCategory != Done AND text ~ "say \\"hi\\"" ORDER BY updated DESC',
    );
  });

  it("searches by key when the text looks like one", () => {
    expect(buildViewJql({ view: "all", projectKey: "", text: "web-12", includeDone: true })).toBe(
      '(key = "WEB-12" OR text ~ "web-12") ORDER BY updated DESC',
    );
  });

  it("keeps an otherwise unrestricted query bounded", () => {
    expect(buildViewJql({ view: "all", projectKey: "", text: "", includeDone: true })).toBe(
      "created >= -365d ORDER BY updated DESC",
    );
  });
});

describe("requiresApproval", () => {
  it("only skips approval for an explicit Always allow", () => {
    expect(requiresApproval(PERMISSION_ALWAYS)).toBe(false);
    expect(requiresApproval(PERMISSION_ASK)).toBe(true);
    expect(requiresApproval(undefined)).toBe(true);
    expect(requiresApproval("always")).toBe(true);
  });
});

describe("normalizeIssue", () => {
  it("fills every field from a sparse payload", () => {
    const issue = normalizeIssue(
      {
        key: "WEB-7",
        fields: {
          summary: "Fix login",
          status: { name: "In Review", statusCategory: { key: "indeterminate" } },
          assignee: null,
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Broken" }] }],
          },
        },
      },
      "https://acme.atlassian.net",
    );
    expect(issue).toMatchObject({
      key: "WEB-7",
      projectKey: "WEB",
      summary: "Fix login",
      status: "In Review",
      statusCategory: "inprogress",
      assignee: null,
      labels: [],
      description: "Broken",
      url: "https://acme.atlassian.net/browse/WEB-7",
    });
  });
});

describe("describeJiraError", () => {
  it("surfaces Jira's field errors", () => {
    expect(
      describeJiraError(400, JSON.stringify({ errorMessages: [], errors: { summary: "required" } })),
    ).toBe("Jira responded 400: summary: required");
  });
});

describe("JiraClient", () => {
  it("sends Basic auth and ADF, and maps 401 to a configuration error", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new JiraClient(
      { siteUrl: "https://acme.atlassian.net", email: "me@acme.dev", apiToken: "tok" },
      async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? new Response(JSON.stringify({ id: "1", body: null }), { status: 201 })
          : new Response("", { status: 401 });
      },
    );
    await client.addComment("WEB-1", "**hi**");
    const [first] = calls;
    expect(first?.url).toBe("https://acme.atlassian.net/rest/api/3/issue/WEB-1/comment");
    expect((first?.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("me@acme.dev:tok").toString("base64")}`,
    );
    expect(JSON.parse(String(first?.init.body))).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "strong" }] }] }],
      },
    });
    await expect(client.myself()).rejects.toMatchObject({ name: "NeedsConfigurationError" });
  });
});

describe("buildViewJql assignee filter", () => {
  it("narrows to people and unassigned together", () => {
    expect(
      buildViewJql({
        view: "all",
        projectKey: "",
        text: "",
        includeDone: true,
        assignees: ["u-1", "u-2", "u-1"],
        unassigned: true,
      }),
    ).toBe('(assignee in ("u-1", "u-2") OR assignee is EMPTY) ORDER BY updated DESC');
  });

  it("uses a single clause without parentheses", () => {
    expect(
      buildViewJql({ view: "recent", projectKey: "", text: "", includeDone: true, unassigned: true }),
    ).toBe("assignee is EMPTY AND updated >= -14d ORDER BY updated DESC");
  });

  it("ignores it on the assigned-to-me view", () => {
    expect(
      buildViewJql({ view: "assigned", projectKey: "", text: "", includeDone: true, assignees: ["u-1"] }),
    ).toBe("assignee = currentUser() ORDER BY updated DESC");
  });
});

describe("scopeJql", () => {
  it("wraps the filter and keeps ORDER BY last", () => {
    expect(scopeJql("status = Done OR assignee = currentUser() ORDER BY rank", ["WEB"])).toBe(
      'project = "WEB" AND (status = Done OR assignee = currentUser()) ORDER BY rank',
    );
  });

  it("handles order-only JQL, several projects, and no projects", () => {
    expect(scopeJql("order by updated DESC", ["WEB", "APP", "WEB"])).toBe(
      'project in ("WEB", "APP") order by updated DESC',
    );
    expect(scopeJql("  status = Done ", [])).toBe("status = Done");
  });

  it("ignores ORDER BY inside quoted text", () => {
    expect(scopeJql('text ~ "sort order by date" ORDER BY created', ["WEB"])).toBe(
      'project = "WEB" AND (text ~ "sort order by date") ORDER BY created',
    );
  });

  it("cannot be escaped by an OR in the caller's JQL", () => {
    // The parentheses are the point: without them `project = WEB AND a OR b`
    // would return b from every project.
    expect(scopeJql("project = OTHER OR key = X-1", ["WEB"])).toBe(
      'project = "WEB" AND (project = OTHER OR key = X-1)',
    );
  });
});
