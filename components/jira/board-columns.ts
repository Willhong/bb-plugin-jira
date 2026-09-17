// Board columns, kept free of React so the ordering rules are testable.
//
// A column is one status (not one category): that is what a Jira board shows,
// and a drop onto a column names exactly which status to transition into.
import type { JiraIssueSummary, JiraStatusOption, StatusCategory } from "../../server";

export interface BoardColumn {
  status: string;
  category: StatusCategory;
  issues: JiraIssueSummary[];
}

const CATEGORY_RANK: Record<StatusCategory, number> = { todo: 0, inprogress: 1, done: 2 };

/**
 * Columns in workflow order: To do, then In progress, then Done categories;
 * within a category, the project's own status order, then any status that
 * only appears on loaded issues (e.g. from another project).
 *
 * `known` statuses become columns even when empty, so an issue can be dropped
 * into a status nothing is in yet. `moves` overrides an issue's status while
 * its transition is in flight.
 */
export function buildBoardColumns(
  issues: JiraIssueSummary[],
  known: JiraStatusOption[],
  moves: ReadonlyMap<string, JiraStatusOption> = new Map(),
): BoardColumn[] {
  const columns = new Map<string, BoardColumn>();
  const order: string[] = [];
  const add = (status: string, category: StatusCategory) => {
    const id = status.toLowerCase();
    if (columns.has(id)) return;
    columns.set(id, { status, category, issues: [] });
    order.push(id);
  };
  for (const status of known) add(status.name, status.category);
  for (const issue of issues) {
    const moved = moves.get(issue.key);
    const status = moved?.name ?? issue.status;
    add(status, moved?.category ?? issue.statusCategory);
    columns.get(status.toLowerCase())?.issues.push(
      moved === undefined ? issue : { ...issue, status: moved.name, statusCategory: moved.category },
    );
  }
  return order
    .map((id, index) => ({ column: columns.get(id) as BoardColumn, index }))
    .sort(
      (left, right) =>
        CATEGORY_RANK[left.column.category] - CATEGORY_RANK[right.column.category] ||
        left.index - right.index,
    )
    .map(({ column }) => column);
}
