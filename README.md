# bb-plugin-jira

Jira Cloud issues in BB: a browser page and side panel, in-place editing, and
`jira_*` agent tools whose writes are approved per action.

```sh
bb plugin install git:https://github.com/Willhong/bb-plugin-jira.git@main
```

For development, install a checkout in place with `bb plugin install .`.

## Settings

| Setting | What it does |
| --- | --- |
| `siteUrl` | `acme`, `acme.atlassian.net`, or the full https URL. |
| `email` | Atlassian account email for the token. |
| `apiToken` | API token (secret; server only). |
| `allow_create`, `allow_update`, `allow_transition`, `allow_comment`, `allow_assign`, `allow_delete` | `Ask every time` (default) or `Always allow`, for agent writes. |

```sh
bb plugin config jira set siteUrl acme.atlassian.net
bb plugin config jira set allow_comment "Always allow"
```

## Project links

A BB project can be linked to one or more Jira projects (Jira page →
**Project links**, or the Jira side panel in a thread). In a linked project's
threads:

- `jira_search_issues` wraps the agent's JQL as `project in (…) AND (<jql>)`,
  so an `OR` cannot widen it; `jira_search_all_issues` is unscoped.
- `jira_create_issue` defaults `projectKey` to the single linked project.
- `@` mentions and the side panel show only linked issues; the panel can switch
  to **All Jira**.
- Agents get an instruction naming the linked projects.

Links live in plugin storage (`project-links`); unlinked projects are unscoped.

## Write rules

- **Agents:** every write tool calls `authorizeAgentWrite` in `server.ts`
  before contacting Jira. Anything other than an explicit `Always allow` asks,
  and the card only approves on `once` or `always`, so the gate fails closed.
- **The page:** the user's click is the intent. Delete confirms in a dialog.

## Layout

| File | Role |
| --- | --- |
| `server.ts` | Settings, rpc for the page, agent tools, approval gate, mentions |
| `jira.ts` | Jira REST v3 client, wire schemas, normalization, JQL for views |
| `adf.ts` | Markdown ⇄ Atlassian Document Format |
| `routes.ts` | Page sub-path (`issue/<KEY>`) |
| `app.tsx`, `components/jira/` | Page, side panel, issue view, dialogs, approval card |

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
```

`vendor/get-bb-plugin-sdk-0.4.98.tgz` is packed from the local bb checkout
because that SDK version is not on npm yet; it is a dev dependency only.
