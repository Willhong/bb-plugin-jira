import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { JiraProject } from "../../server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateOptions, useJiraRpc } from "./hooks";
import { PriorityMark, TypeGlyph, errorText } from "./primitives";

const DEFAULT_PRIORITY = "__default__";

export function CreateIssueDialog({
  open,
  onOpenChange,
  projects,
  initialProjectKey,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: JiraProject[];
  initialProjectKey: string;
  onCreated: (key: string) => void;
}) {
  const rpc = useJiraRpc();
  const [projectKey, setProjectKey] = useState(initialProjectKey);
  const [issueType, setIssueType] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [busy, setBusy] = useState(false);
  const options = useCreateOptions(open ? projectKey : "");

  useEffect(() => {
    if (open) setProjectKey((current) => current || initialProjectKey || projects[0]?.key || "");
  }, [open, initialProjectKey, projects]);

  // Default to Task (or the first non-sub-task type) whenever the project's
  // types change, since type ids differ between projects.
  useEffect(() => {
    const types = options.issueTypes.filter((type) => !type.subtask);
    if (types.some((type) => type.id === issueType)) return;
    setIssueType((types.find((type) => type.name.toLowerCase() === "task") ?? types[0])?.id ?? "");
  }, [options.issueTypes, issueType]);

  const reset = () => {
    setSummary("");
    setDescription("");
    setPriority(DEFAULT_PRIORITY);
  };

  const canSubmit = projectKey.length > 0 && issueType.length > 0 && summary.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    rpc
      .call("createIssue", {
        projectKey,
        issueType,
        summary: summary.trim(),
        description,
        priority: priority === DEFAULT_PRIORITY ? "" : priority,
        assigneeAccountId: "",
      })
      .then(({ key }) => {
        toast.success(`Created ${key}`);
        reset();
        onOpenChange(false);
        onCreated(key);
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create issue</DialogTitle>
          <DialogDescription>Creates the issue in Jira right away.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project">
              <Select value={projectKey || undefined} onValueChange={setProjectKey}>
                <SelectTrigger aria-label="Project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.key} value={project.key}>
                      {project.name} <span className="text-muted-foreground">({project.key})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Type">
              <Select
                value={issueType || undefined}
                onValueChange={setIssueType}
                disabled={options.issueTypes.length === 0}
              >
                <SelectTrigger aria-label="Issue type">
                  <SelectValue placeholder={options.loading ? "Loading…" : "Choose a type"} />
                </SelectTrigger>
                <SelectContent>
                  {options.issueTypes
                    .filter((type) => !type.subtask)
                    .map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        <span className="flex items-center gap-2">
                          <TypeGlyph type={type.name} />
                          {type.name}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Summary">
            <Input
              autoFocus
              aria-label="Summary"
              maxLength={255}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          <Field label="Description">
            <Textarea
              aria-label="Description"
              rows={6}
              placeholder="Markdown supported"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          {options.priorities.length > 0 ? (
            <Field label="Priority">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger aria-label="Priority" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_PRIORITY}>Project default</SelectItem>
                  {options.priorities.map((name) => (
                    <SelectItem key={name} value={name}>
                      <span className="flex items-center gap-2">
                        <PriorityMark priority={name} />
                        {name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
