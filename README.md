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
| `allow_create`, `allow_update`, `allow_transition`, `allow_comment`, `allow_assign`, `allow_sprint`, `allow_delete` | `Ask every time` (default) or `Always allow`, for agent writes. |
| `settle_on_done` | Settle the issue's agent threads in BB Sidebar when it reaches a done status (default on). |

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

## Done issues settle their threads

When an issue reaches a **done** status through this plugin — the board, the
issue view, or `jira_transition_issue` — every thread **Send to agent** started
for it is settled in [BB Sidebar](https://github.com/Willhong/bb-sidebar)
(`bb.sdk.plugins.callRpc` → its `settle` rpc), which also releases the thread's
runtime and terminals. Each thread settles at most once, so un-settling it
afterwards sticks. Sidebar is optional: without it the transition is unaffected
and the attempt is only logged. Turn it off with `settle_on_done`.

A status change made outside BB (Jira's own web UI, another tool) is not seen —
there is no polling.

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

## Dependency reads (ATD-14)

`jira_get_dependencies {key}` and RPC `getDependencies {key}` return JSON
`{key, blockedBy, blocking}` from Jira Blocks links. Inward linked issues
are prerequisites; outward linked issues are dependents. Each item has
`id`, `key`, `projectKey`, `title`, `url`, current `status` and native
`statusCategory` (`todo`, `inprogress`, `done`). The done category alone
does not distinguish cancellation. Duplicate/related/parent links do not
count. Blocks is recognized by its name or the standard directional labels;
fully renamed custom link types need a separate mapping.

The client requests `issuelinks`, then reads each distinct linked issue's
current state across projects. More than 100 Blocks links or an unreadable
item/malformed response fails the read rather than yielding a partial graph.
At most five linked-item reads run at once.

HongCore:

```sh
bb hongcore run jira bb.rpc --input '{"method":"getDependencies","input":{"key":"PROJ-123"}}' --wait --json
```

The same source runs in BB and HongCore; build and reload both after edits.

## Dependency writes

`jira_update_dependencies {key, addBlockedBy, addBlocking, remove}` and RPC
`updateDependencies` (the issue view; no approval). Adds use
`POST /rest/api/3/issueLink` with the site's Blocks type id (from
`/rest/api/3/issueLinkType`, matched like reads); removes use
`DELETE /rest/api/3/issueLink/{id}` on every Blocks link of the pair, so other
link types survive. Agent writes go through the `update` (Edit issue fields)
policy.

Which create-body field names the blocker is not documented consistently, so
`addBlocksLink` reads the blocked issue back after each create. If Jira
recorded the link the other way round, that link is deleted and recreated with
the ends swapped, and the process remembers the swap. A wrong-way link never
stays. Same-way duplicates are no-ops; reversed links, self-links and
removing a non-dependency are refused before the prompt; anything Jira did not
record after writing is an error. The issue view has a Dependencies section
(Blocked by / Blocking, add by search or full key, remove with ×).

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
