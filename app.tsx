// bb-plugin-jira — the frontend bundle.
//
// A Jira issue browser (nav page and thread side panel) and the approval card
// agents' Jira writes wait on. Components live in components/jira/.
import { useCallback, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { ApprovalCard } from "@/components/jira/approval-card";
import { JiraBrowser } from "@/components/jira/browser";
import { parseSubPath, routeToSubPath } from "./routes";

const PANEL_PATH = "jira";

function JiraPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const select = useCallback(
    (issueKey: string | null) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath({ issueKey }) });
    },
    [navigate],
  );
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <JiraBrowser selectedKey={route.issueKey} onSelect={select} />
    </div>
  );
}

/**
 * A side panel has no route, so the open issue lives in component state.
 * It follows the thread's BB project, so a linked project shows only its
 * Jira projects' issues.
 */
function JiraSidePanel(_props: PluginThreadPanelProps) {
  const { projectId } = useBbContext();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <JiraBrowser compact bbProjectId={projectId} selectedKey={selectedKey} onSelect={setSelectedKey} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "jira",
    title: "Jira",
    icon: "ListTodo",
    path: PANEL_PATH,
    component: JiraPage,
  });
  app.slots.threadPanelAction({
    id: "issues",
    title: "Jira",
    icon: "ListTodo",
    layout: "flush",
    component: JiraSidePanel,
  });
  app.slots.pendingInteraction({
    id: "jira-approve-write",
    component: ApprovalCard,
  });
});
