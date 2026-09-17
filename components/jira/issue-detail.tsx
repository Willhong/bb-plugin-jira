// One issue, edited in place the way Jira's issue view works: click the title
// or description to edit, change status from the lozenge, and change
// assignee, priority, and labels from the field column. Everything here is
// the user's own action, so only delete asks for confirmation.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { AgentTargets, JiraComment, JiraIssue, JiraIssueDetail, JiraUser } from "../../server";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCreateOptions, useIssueDetail, useJiraRpc } from "./hooks";
import {
  Avatar,
  InlineError,
  IssueKey,
  PriorityMark,
  StatusLozenge,
  TypeGlyph,
  absoluteTime,
  errorText,
  relativeTime,
} from "./primitives";

export function IssueDetail({
  issueKey,
  onClose,
  onOpenIssue,
  currentUser,
}: {
  issueKey: string;
  onClose: () => void;
  onOpenIssue: (key: string) => void;
  currentUser: JiraUser | null;
}) {
  const { detail, error, deleted, refetch } = useIssueDetail(issueKey);

  if (deleted) {
    return (
      <DetailFrame onClose={onClose}>
        <p className="py-10 text-center text-sm text-muted-foreground">
          {issueKey} was deleted.
        </p>
      </DetailFrame>
    );
  }
  if (detail === null) {
    return (
      <DetailFrame onClose={onClose}>
        {error !== null ? (
          <div className="space-y-2">
            <InlineError message={error} />
            <Button size="sm" variant="outline" onClick={refetch}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </DetailFrame>
    );
  }
  return (
    <LoadedIssue
      detail={detail}
      onClose={onClose}
      onOpenIssue={onOpenIssue}
      currentUser={currentUser}
    />
  );
}

function DetailFrame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="icon" variant="ghost" className="size-8" aria-label="Close issue" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}

function LoadedIssue({
  detail,
  onClose,
  onOpenIssue,
  currentUser,
}: {
  detail: JiraIssueDetail;
  onClose: () => void;
  onOpenIssue: (key: string) => void;
  currentUser: JiraUser | null;
}) {
  const { issue } = detail;
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);

  return (
    <article className="@container space-y-4" aria-label={`${issue.key} ${issue.summary}`}>
      <header className="flex items-center gap-2">
        <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          {issue.parent !== null ? (
            <>
              <button
                type="button"
                className="truncate hover:text-foreground hover:underline"
                title={issue.parent.summary}
                onClick={() => issue.parent && onOpenIssue(issue.parent.key)}
              >
                {issue.parent.key}
              </button>
              <span aria-hidden>/</span>
            </>
          ) : null}
          <TypeGlyph type={issue.issueType} />
          <IssueKey issueKey={issue.key} />
        </nav>
        <Button size="sm" variant="outline" onClick={() => setSending(true)}>
          <Icon name="Bot" className="size-4" />
          Send to agent
        </Button>
        <Button asChild size="icon" variant="ghost" className="size-8">
          <UrlLink href={issue.url} aria-label="Open in Jira" title="Open in Jira">
            <Icon name="ExternalLink" className="size-4" />
          </UrlLink>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label="More actions">
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard.writeText(issue.key).then(() => toast.success(`Copied ${issue.key}`));
              }}
            >
              <Icon name="Copy" className="size-4" />
              Copy key
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard.writeText(issue.url).then(() => toast.success("Copied link"));
              }}
            >
              <Icon name="Copy" className="size-4" />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Icon name="Trash2" className="size-4" />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Close issue" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </header>

      <EditableSummary issue={issue} />

      <div className="flex flex-col gap-6 @2xl:flex-row-reverse @2xl:items-start">
        <aside className="w-full shrink-0 @2xl:sticky @2xl:top-0 @2xl:w-64">
          <FieldsPanel detail={detail} currentUser={currentUser} />
        </aside>
        <div className="min-w-0 flex-1 space-y-6">
          <DescriptionEditor issue={issue} />
          <CommentsSection
            issueKey={issue.key}
            comments={detail.comments}
            total={detail.commentTotal}
          />
        </div>
      </div>

      <DeleteIssueDialog issue={issue} open={deleting} onOpenChange={setDeleting} onDeleted={onClose} />
      <SendToAgentDialog issue={issue} open={sending} onOpenChange={setSending} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Title and description.
// ---------------------------------------------------------------------------

function EditableSummary({ issue }: { issue: JiraIssue }) {
  const rpc = useJiraRpc();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = () => {
    const next = draft?.trim() ?? "";
    if (next.length === 0 || next === issue.summary) {
      setDraft(null);
      return;
    }
    setSaving(true);
    rpc
      .call("updateIssue", { key: issue.key, summary: next })
      .then(() => setDraft(null))
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setSaving(false));
  };

  if (draft !== null) {
    return (
      <Input
        autoFocus
        aria-label="Summary"
        value={draft}
        disabled={saving}
        maxLength={255}
        className="h-auto py-1.5 text-xl font-semibold"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(null);
        }}
      />
    );
  }
  return (
    <h2>
      <button
        type="button"
        title="Edit summary"
        className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 py-1 text-left text-xl font-semibold leading-snug text-foreground hover:bg-state-hover"
        onClick={() => setDraft(issue.summary)}
      >
        {issue.summary}
      </button>
    </h2>
  );
}

function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submit();
  }
}

function DescriptionEditor({ issue }: { issue: JiraIssue }) {
  const rpc = useJiraRpc();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = () => {
    if (draft === null) return;
    setSaving(true);
    rpc
      .call("updateIssue", { key: issue.key, description: draft })
      .then(() => setDraft(null))
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setSaving(false));
  };

  return (
    <section className="space-y-2">
      <SectionTitle>Description</SectionTitle>
      {draft !== null ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            aria-label="Description"
            value={draft}
            disabled={saving}
            rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
            className="font-mono text-[13px]"
            placeholder="Markdown: **bold**, `code`, lists, ``` code blocks"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
              submitOnModEnter(event, save);
            }}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">⌘↵ to save · Markdown</span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          title="Edit description"
          className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1.5 text-left hover:bg-state-hover"
          onClick={() => setDraft(issue.description)}
        >
          {issue.description.trim().length > 0 ? (
            <Markdown content={issue.description} className="text-sm" />
          ) : (
            <span className="text-sm text-muted-foreground">Add a description…</span>
          )}
        </button>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-foreground">{children}</h3>;
}

// ---------------------------------------------------------------------------
// Comments.
// ---------------------------------------------------------------------------

function CommentsSection({
  issueKey,
  comments,
  total,
}: {
  issueKey: string;
  comments: JiraComment[];
  total: number;
}) {
  const rpc = useJiraRpc();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  const post = () => {
    const text = body.trim();
    if (text.length === 0 || posting) return;
    setPosting(true);
    rpc
      .call("addComment", { key: issueKey, body: text })
      .then(() => setBody(""))
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  };

  return (
    <section className="space-y-3">
      <SectionTitle>
        Comments <span className="font-normal text-muted-foreground">{total}</span>
      </SectionTitle>
      <div className="space-y-2">
        <Textarea
          aria-label="Add a comment"
          placeholder="Add a comment…"
          value={body}
          rows={body.length > 0 ? 4 : 2}
          disabled={posting}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => submitOnModEnter(event, post)}
        />
        {body.trim().length > 0 ? (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={posting} onClick={post}>
              {posting ? "Posting…" : "Comment"}
            </Button>
            <Button size="sm" variant="ghost" disabled={posting} onClick={() => setBody("")}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">⌘↵ to post</span>
          </div>
        ) : null}
      </div>
      {total > comments.length ? (
        <p className="text-xs text-muted-foreground">
          Showing the latest {comments.length} of {total} comments.
        </p>
      ) : null}
      <ol className="space-y-4">
        {[...comments].reverse().map((comment) => (
          <li key={comment.id} className="flex gap-3">
            <Avatar user={comment.author} size="md" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-foreground">
                  {comment.author?.displayName ?? "Unknown"}
                </span>
                <time className="text-xs text-muted-foreground" title={absoluteTime(comment.created)}>
                  {relativeTime(comment.created)}
                  {comment.updated !== comment.created ? " · edited" : ""}
                </time>
              </p>
              <Markdown content={comment.body || "(empty)"} className="mt-1 text-sm" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Field column.
// ---------------------------------------------------------------------------

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-2 py-1.5 text-sm @2xl:grid-cols-1 @2xl:gap-1">
      <dt className="pt-1 text-xs text-muted-foreground @2xl:pt-0">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function FieldsPanel({ detail, currentUser }: { detail: JiraIssueDetail; currentUser: JiraUser | null }) {
  const { issue } = detail;
  const navigate = useBbNavigate();
  return (
    <div className="space-y-3">
      <StatusControl detail={detail} />
      <dl className="rounded-lg border border-border px-3 py-1.5">
        <FieldRow label="Assignee">
          <AssigneeControl issue={issue} currentUser={currentUser} />
        </FieldRow>
        <FieldRow label="Priority">
          <PriorityControl issue={issue} />
        </FieldRow>
        <FieldRow label="Labels">
          <LabelsControl issue={issue} />
        </FieldRow>
        <FieldRow label="Reporter">
          <span className="flex items-center gap-2 pt-0.5">
            <Avatar user={issue.reporter} />
            <span className="truncate">{issue.reporter?.displayName ?? "—"}</span>
          </span>
        </FieldRow>
        <FieldRow label="Type">
          <span className="flex items-center gap-2 pt-0.5">
            <TypeGlyph type={issue.issueType} />
            {issue.issueType}
          </span>
        </FieldRow>
      </dl>
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        Created <span title={absoluteTime(issue.created)}>{relativeTime(issue.created)}</span>
        <br />
        Updated <span title={absoluteTime(issue.updated)}>{relativeTime(issue.updated)}</span>
      </p>
      {detail.threads.length > 0 ? (
        <div className="space-y-1.5 px-1">
          <p className="text-xs text-muted-foreground">Agent threads</p>
          <div className="flex flex-wrap gap-1.5">
            {detail.threads.map((link, index) => (
              <Button
                key={link.threadId}
                size="sm"
                variant="outline"
                onClick={() => navigate.toThread(link.threadId)}
              >
                <Icon name="Bot" className="size-3.5" />
                Thread {index + 1}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusControl({ detail }: { detail: JiraIssueDetail }) {
  const rpc = useJiraRpc();
  const { issue, transitions } = detail;
  const [pending, setPending] = useState<string | null>(null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending !== null}
          aria-label={`Status: ${issue.status}. Change status`}
          className="inline-flex items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        >
          <StatusLozenge
            name={pending ?? issue.status}
            category={
              transitions.find((transition) => transition.toStatus === pending)?.toCategory ??
              issue.statusCategory
            }
            className="py-1 pl-2 pr-1 text-xs"
          />
          <Icon name="ChevronDown" className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Move to
        </DropdownMenuLabel>
        {transitions.length === 0 ? (
          <DropdownMenuItem disabled>No transitions available</DropdownMenuItem>
        ) : (
          transitions.map((transition) => (
            <DropdownMenuItem
              key={transition.id}
              onSelect={() => {
                setPending(transition.toStatus);
                rpc
                  .call("transitionIssue", { key: issue.key, transitionId: transition.id })
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setPending(null));
              }}
            >
              <StatusLozenge name={transition.toStatus} category={transition.toCategory} />
              {transition.name.toLowerCase() !== transition.toStatus.toLowerCase() ? (
                <span className="ml-auto pl-3 text-xs text-muted-foreground">{transition.name}</span>
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AssigneeControl({ issue, currentUser }: { issue: JiraIssue; currentUser: JiraUser | null }) {
  const rpc = useJiraRpc();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<JiraUser[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!picking) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc.call("findUsers", { issueKey: issue.key, projectKey: "", query }).then(
        (found) => live && setUsers(found),
        () => live && setUsers([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, picking, query, issue.key]);

  const assign = (accountId: string | null) => {
    setSaving(true);
    rpc
      .call("assignIssue", { key: issue.key, accountId })
      .then(() => {
        setPicking(false);
        setQuery("");
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setSaving(false));
  };

  const isMine = currentUser !== null && issue.assignee?.accountId === currentUser.accountId;

  if (!picking) {
    return (
      <div className="space-y-0.5">
        <button
          type="button"
          className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-state-hover"
          onClick={() => setPicking(true)}
        >
          <Avatar user={issue.assignee} />
          <span className={cn("truncate", issue.assignee === null && "text-muted-foreground")}>
            {issue.assignee?.displayName ?? "Unassigned"}
          </span>
        </button>
        {currentUser !== null && !isMine ? (
          <button
            type="button"
            disabled={saving}
            className="text-xs text-primary hover:underline disabled:opacity-60"
            onClick={() => assign(currentUser.accountId)}
          >
            Assign to me
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Input
        autoFocus
        aria-label="Search people"
        placeholder="Search people"
        value={query}
        className="h-8 text-sm"
        disabled={saving}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPicking(false);
        }}
      />
      <ul className="max-h-56 overflow-y-auto rounded-md border border-border py-1">
        <li>
          <button
            type="button"
            disabled={saving}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-state-hover"
            onClick={() => assign(null)}
          >
            <Avatar user={null} />
            Unassigned
          </button>
        </li>
        {users === null ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">Searching…</li>
        ) : users.length === 0 ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">No matching people</li>
        ) : (
          users.map((user) => (
            <li key={user.accountId}>
              <button
                type="button"
                disabled={saving}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-state-hover",
                  user.accountId === issue.assignee?.accountId && "bg-state-active",
                )}
                onClick={() => assign(user.accountId)}
              >
                <Avatar user={user} />
                <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      <Button size="sm" variant="ghost" className="h-7" onClick={() => setPicking(false)}>
        Cancel
      </Button>
    </div>
  );
}

function PriorityControl({ issue }: { issue: JiraIssue }) {
  const rpc = useJiraRpc();
  const [open, setOpen] = useState(false);
  // Priorities are loaded on first open; most views never change one.
  const { priorities } = useCreateOptions(open ? issue.projectKey : "");
  const options = priorities.length > 0 ? priorities : issue.priority ? [issue.priority] : [];

  return (
    <Select
      value={issue.priority || undefined}
      onOpenChange={(next) => next && setOpen(true)}
      onValueChange={(priority) => {
        if (priority === issue.priority) return;
        rpc
          .call("updateIssue", { key: issue.key, priority })
          .catch((error: unknown) => toast.error(errorText(error)));
      }}
    >
      <SelectTrigger className="h-8 w-full" aria-label="Priority">
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        {options.map((priority) => (
          <SelectItem key={priority} value={priority}>
            <span className="flex items-center gap-2">
              <PriorityMark priority={priority} />
              {priority}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LabelsControl({ issue }: { issue: JiraIssue }) {
  const rpc = useJiraRpc();
  const [draft, setDraft] = useState<string | null>(null);

  const save = () => {
    if (draft === null) return;
    // Jira labels cannot contain spaces, so whitespace separates them too.
    const labels = [...new Set(draft.split(/[\s,]+/).filter(Boolean))];
    setDraft(null);
    if (labels.join(",") === issue.labels.join(",")) return;
    rpc
      .call("updateIssue", { key: issue.key, labels })
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  if (draft !== null) {
    return (
      <Input
        autoFocus
        aria-label="Labels"
        placeholder="label-one label-two"
        value={draft}
        className="h-8 text-sm"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="-mx-1 flex min-h-7 w-[calc(100%+0.5rem)] flex-wrap items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
      onClick={() => setDraft(issue.labels.join(" "))}
    >
      {issue.labels.length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        issue.labels.map((label) => (
          <span key={label} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
            {label}
          </span>
        ))
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dialogs.
// ---------------------------------------------------------------------------

function DeleteIssueDialog({
  issue,
  open,
  onOpenChange,
  onDeleted,
}: {
  issue: JiraIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const rpc = useJiraRpc();
  const [withSubtasks, setWithSubtasks] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {issue.key}?</AlertDialogTitle>
          <AlertDialogDescription>
            “{issue.summary}” will be permanently deleted from Jira, with its comments and
            history. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={withSubtasks} onCheckedChange={(checked) => setWithSubtasks(checked === true)} />
          Also delete its sub-tasks
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              setBusy(true);
              rpc
                .call("deleteIssue", { key: issue.key, deleteSubtasks: withSubtasks })
                .then(() => {
                  toast.success(`Deleted ${issue.key}`);
                  onOpenChange(false);
                  onDeleted();
                })
                .catch((error: unknown) => toast.error(errorText(error)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The thread starts in the BB project linked to the issue's Jira project.
 * With several linked projects the user picks one; with none, they pick any
 * project and, by default, link it so the next send goes straight there.
 */
function SendToAgentDialog({
  issue,
  open,
  onOpenChange,
}: {
  issue: JiraIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useJiraRpc();
  const navigate = useBbNavigate();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<AgentTargets | null>(null);
  const [bbProjectId, setBbProjectId] = useState("");
  const [linkProject, setLinkProject] = useState(true);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setTargets(null);
    rpc.call("agentTargets", { key: issue.key }).then(
      (next) => {
        if (!live) return;
        setTargets(next);
        setBbProjectId(next.linked.length === 1 ? (next.linked[0]?.bbProjectId ?? "") : "");
      },
      (error: unknown) => live && toast.error(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, [rpc, open, issue.key]);

  const linkedIds = new Set(targets?.linked.map((project) => project.bbProjectId) ?? []);
  const chosenIsLinked = linkedIds.has(bbProjectId);
  const others = targets?.all.filter((project) => !linkedIds.has(project.bbProjectId)) ?? [];

  const send = () => {
    if (bbProjectId.length === 0 || busy) return;
    setBusy(true);
    rpc
      .call("sendToAgent", {
        key: issue.key,
        bbProjectId,
        note,
        linkProject: !chosenIsLinked && linkProject,
      })
      .then(({ threadId }) => {
        onOpenChange(false);
        setNote("");
        navigate.toThread(threadId);
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {issue.key} to an agent</DialogTitle>
          <DialogDescription>
            Starts a chat with the issue, its description, and recent comments.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">BB project</span>
          {targets === null ? (
            <Skeleton className="h-9 w-full" />
          ) : targets.linked.length === 1 && chosenIsLinked ? (
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground">{targets.linked[0]?.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">linked to {targets.jiraProjectKey}</span>
              <button
                type="button"
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setBbProjectId("")}
              >
                Change
              </button>
            </div>
          ) : (
            <Select value={bbProjectId || undefined} onValueChange={setBbProjectId}>
              <SelectTrigger aria-label="BB project">
                <SelectValue
                  placeholder={
                    targets.linked.length > 1
                      ? `${targets.linked.length} projects are linked to ${targets.jiraProjectKey} — pick one`
                      : "Choose a BB project"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {targets.linked.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Linked to {targets.jiraProjectKey}</SelectLabel>
                    {targets.linked.map((project) => (
                      <SelectItem key={project.bbProjectId} value={project.bbProjectId}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {others.length > 0 ? (
                  <SelectGroup>
                    {targets.linked.length > 0 ? <SelectLabel>Other projects</SelectLabel> : null}
                    {others.map((project) => (
                      <SelectItem key={project.bbProjectId} value={project.bbProjectId}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          )}
          {targets !== null && targets.linked.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No BB project is linked to {targets.jiraProjectKey} yet.
            </p>
          ) : null}
          {bbProjectId.length > 0 && targets !== null && !chosenIsLinked ? (
            <label className="mt-1 flex items-center gap-2 text-sm">
              <Checkbox checked={linkProject} onCheckedChange={(checked) => setLinkProject(checked === true)} />
              Link {targets.jiraProjectKey} to this project
            </label>
          ) : null}
        </div>

        <Textarea
          aria-label="Instructions"
          placeholder="What should the agent do? (optional)"
          rows={4}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => submitOnModEnter(event, send)}
        />
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || bbProjectId.length === 0} onClick={send}>
            {busy ? "Starting…" : "Start chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
