// Panel routing, kept out of app.tsx so it is testable without a DOM.
//
// The nav panel owns /plugins/jira/jira/*:
//   ""               the issue list
//   "issue/<KEY>"    the list with one issue open beside (or over) it

export type Route = { issueKey: string | null };

export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "issue" && parts.length === 2) {
    const key = (parts[1] ?? "").toUpperCase();
    if (/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key)) return { issueKey: key };
  }
  return { issueKey: null };
}

export function routeToSubPath(route: Route): string {
  return route.issueKey === null ? "" : `issue/${route.issueKey}`;
}
