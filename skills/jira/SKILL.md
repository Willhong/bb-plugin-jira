---
name: jira
description: Read and change Jira Cloud issues with the jira_* agent tools — search with JQL, read an issue with its comments, create, edit fields, move status, add/edit/delete comments, assign, move between sprints, or delete. Use when the user mentions a Jira issue key (PROJ-123), asks what is assigned to them, or wants work reflected back into Jira.
---

# Jira

## Read first

- `jira_search_issues` — JQL in, one row per issue out (key, type, status,
  priority, assignee, summary). Example:
  `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
  **In a BB project linked to Jira projects, results are limited to those
  projects** (the first output line names the scope); leave `project = …` out.
- `jira_search_all_issues` — the same, across every Jira project. Use it only
  when the user asks about issues outside the linked projects.
- `jira_get_issue` — fields, the description as Markdown, the latest comments
  (each headed `[comment <id>]`),
  and the transitions available right now. Read it before transitioning or
  editing so you use real status names.
- `jira_list_sprints` lists a project's scrum-board sprints (id, state, board,
  name, dates); defaults to active and future. Use it before
  `jira_move_to_sprint` when the target sprint is unclear.

## Writes

| Tool | Changes |
| --- | --- |
| `jira_create_issue` | New issue. `projectKey` defaults to the linked Jira project when there is exactly one. `assignee` takes `me`, a name, or an email. |
| `jira_update_issue` | Summary, description, priority, labels. `description` and `labels` **replace** the current value — read first and send the full result. |
| `jira_transition_issue` | Status, by transition name or target status (`Done`, `In Progress`). |
| `jira_add_comment` | Markdown comment. Returns the new comment id. |
| `jira_update_comment` | Replace a comment's body (full Markdown). Fix a posted comment this way instead of adding a correction. |
| `jira_delete_comment` | Permanent. Only when the user asked, e.g. to merge split comments. |
| `jira_assign_issue` | `me`, `unassigned`, a name, or an email. |
| `jira_move_to_sprint` | Up to 50 `keys` into a sprint: a sprint id, an exact sprint name, `active` (the one active sprint), or `backlog`. Closed sprints are refused. Ambiguous names return the open sprint list — pass the id or `boardId`. |
| `jira_delete_issue` | Permanent. Only when the user explicitly asked to delete. |

Descriptions and comments are Markdown; the plugin converts to Jira's format.
Inline code inside bold/italic stays code but loses the bold on that span —
Jira's format does not allow both on one piece of text.

Comment edits share the **comment** approval policy; comment deletes share
the **delete** policy.

## Approval

Each write action has its own policy in the plugin settings: **Ask every
time** (default) or **Always allow**. When it asks, the tool call waits for the
user's card in the thread. A declined or timed-out approval returns an error
saying nothing was sent — do not retry the same write unless the user asks.
The user can pick "Always allow" on the card to stop asking for that action.
