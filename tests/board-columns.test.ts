import { describe, expect, it } from "vitest";
import type { JiraIssueSummary } from "../server";
import { buildBoardColumns } from "../components/jira/board-columns";

function issue(key: string, status: string, statusCategory: JiraIssueSummary["statusCategory"]): JiraIssueSummary {
  return {
    id: key, key, projectKey: key.split("-")[0] ?? "", summary: key, status, statusCategory,
    issueType: "Task", subtask: false, priority: "", assignee: null, reporter: null, labels: [],
    created: "", updated: "",
  };
}

describe("buildBoardColumns", () => {
  it("orders columns by category, keeping empty known statuses as drop targets", () => {
    const columns = buildBoardColumns(
      [issue("A-1", "In Review", "inprogress"), issue("A-2", "To Do", "todo"), issue("A-3", "Doing", "inprogress")],
      [
        { name: "Done", category: "done" },
        { name: "Doing", category: "inprogress" },
        { name: "To Do", category: "todo" },
      ],
    );
    expect(columns.map((column) => [column.status, column.issues.map((entry) => entry.key)])).toEqual([
      ["To Do", ["A-2"]],
      ["Doing", ["A-3"]],
      ["In Review", ["A-1"]],
      ["Done", []],
    ]);
  });

  it("matches status names case-insensitively and applies in-flight moves", () => {
    const columns = buildBoardColumns(
      [issue("A-1", "to do", "todo"), issue("A-2", "To Do", "todo")],
      [{ name: "To Do", category: "todo" }, { name: "Done", category: "done" }],
      new Map([["A-2", { name: "Done", category: "done" as const }]]),
    );
    expect(columns.map((column) => [column.status, column.issues.map((entry) => entry.key)])).toEqual([
      ["To Do", ["A-1"]],
      ["Done", ["A-2"]],
    ]);
    expect(columns[1]?.issues[0]?.statusCategory).toBe("done");
  });
});
