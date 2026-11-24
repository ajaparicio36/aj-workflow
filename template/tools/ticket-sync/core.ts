import { CONFIG, MARKERS, STATUS_META, STATUSES, TICKET_TYPES, jiraMarker } from "./config.ts";
import type { RepoKey, Status, TicketType } from "./config.ts";

/** Ordering facts from the issue's events API, in API order with a 0-based sequence number. -1 = never. */
export interface IssueHistory {
  /** label name -> sequence of its latest `labeled` event; a present label with no event is treated as -1 */
  readonly labelAdded: Readonly<Record<string, number>>;
  readonly lastAssigned: number;
  readonly lastUnassigned: number;
  readonly lastReopened: number;
}

export interface LiveIssue {
  readonly number: number;
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly htmlUrl: string;
  readonly history: IssueHistory;
}

export type IssueAction =
  | "opened" | "edited" | "reopened" | "closed"
  | "assigned" | "unassigned" | "labeled" | "unlabeled";

export interface IssueEvent {
  readonly action: IssueAction;
  /** label name for labeled/unlabeled, otherwise null */
  readonly label: string | null;
}

export interface LabelDiff {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export interface IssuePlan {
  readonly status: Status;
  readonly labels: LabelDiff;
  readonly closeIssue: boolean;
  readonly ensureBranchesIn: readonly RepoKey[];
  readonly ticketType: TicketType;
  readonly warnings: readonly string[];
}

/** Live pull request state (refetched, never taken from the event payload). */
export interface PrState {
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly defaultBranch: string;
  readonly title: string;
  readonly htmlUrl: string;
}

export interface PrPlan {
  /** Jira key like "ACME-12", uppercased; null when no key found */
  readonly key: string | null;
  /** hub status to set; null = change nothing */
  readonly status: Status | null;
}

export type MergeOutcome = "close" | "comment";

export interface LinkedBranch {
  readonly repo: string;   // repository name, e.g. "acme-app"
  readonly branch: string;
}

export interface BranchEntry extends LinkedBranch {
  readonly created: boolean;
}

const STATUS_PREFIX = "status:";
const REPO_PREFIX = "repo:";
const REPO_KEYS: RepoKey[] = Object.keys(CONFIG.repos);
const KEY_PATTERN = `${CONFIG.jiraProjectKey}-\\d+`;
const JIRA_KEY_RE = new RegExp(`(?:^|[/\\s\\[(])(${KEY_PATTERN})(?=$|[-\\s\\]):_/])`, "i");
const MARKER_RE = new RegExp(`<!-- jira:(${KEY_PATTERN}) -->`);
const MARKER_RE_ALL = new RegExp(MARKER_RE.source, "g");

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function statusOfLabel(label: string): Status | null {
  if (!label.startsWith(STATUS_PREFIX)) return null;
  const rest = label.slice(STATUS_PREFIX.length);
  return isStatus(rest) ? rest : null;
}

export function desiredStatus(issue: LiveIssue): Status {
  if (issue.state === "closed") return "done";
  const assigned = issue.assignees.length > 0;
  const seq = (label: string): number => issue.history.labelAdded[label] ?? -1;

  const present = issue.labels.flatMap((label) => {
    const status = statusOfLabel(label);
    return status === null ? [] : [{ label, status, at: seq(label) }];
  });
  // highest seq wins; ties go to the furthest status
  const newest = present.reduce<(typeof present)[number] | null>(
    (best, c) =>
      best === null || c.at > best.at || (c.at === best.at && STATUSES.indexOf(c.status) > STATUSES.indexOf(best.status))
        ? c
        : best,
    null,
  );
  if (newest === null) return assigned ? "in-progress" : "todo";

  const { lastAssigned, lastUnassigned, lastReopened } = issue.history;
  const at = newest.at;
  switch (newest.status) {
    case "done":
      return lastReopened > at ? (assigned ? "in-progress" : "todo") : "done";
    case "todo":
      return assigned && lastAssigned > at ? "in-progress" : "todo";
    case "in-progress":
      return !assigned && lastUnassigned > at ? "todo" : "in-progress";
    default:
      return newest.status;
  }
}

export function statusLabelDiff(labels: readonly string[], status: Status): LabelDiff {
  const wanted = STATUS_META[status].label;
  return {
    add: labels.includes(wanted) ? [] : [wanted],
    remove: labels.filter((l) => l.startsWith(STATUS_PREFIX) && l !== wanted),
  };
}

/** `unknown` holds the full offending label names, e.g. "repo:zzz". */
export function repoKeysOf(labels: readonly string[]): {
  readonly keys: readonly RepoKey[];
  readonly unknown: readonly string[];
} {
  const found = new Set<string>();
  const unknown: string[] = [];
  for (const label of labels) {
    if (!label.startsWith(REPO_PREFIX)) continue;
    const key = label.slice(REPO_PREFIX.length);
    if (Object.hasOwn(CONFIG.repos, key)) found.add(key);
    else if (!unknown.includes(label)) unknown.push(label);
  }
  return { keys: REPO_KEYS.filter((k) => found.has(k)), unknown };
}

export function ticketTypeOf(labels: readonly string[]): TicketType {
  return TICKET_TYPES.find((t) => labels.includes(`type:${t}`)) ?? CONFIG.defaultType;
}

export function formLabels(body: string): string[] {
  const sections = new Map<string, string>();
  // chunk 0 is whatever precedes the first heading
  for (const chunk of body.split(/^### /m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const title = (nl === -1 ? chunk : chunk.slice(0, nl)).trim().toLowerCase();
    const value = (nl === -1 ? "" : chunk.slice(nl + 1)).trim();
    if (value !== "" && value !== "_No response_" && !sections.has(title)) sections.set(title, value);
  }
  const out = new Set<string>();
  const type = sections.get("type")?.toLowerCase();
  if (type !== undefined && (TICKET_TYPES as readonly string[]).includes(type)) out.add(`type:${type}`);
  for (const raw of (sections.get("repos") ?? "").split(",")) {
    const key = raw.trim().toLowerCase();
    if (Object.hasOwn(CONFIG.repos, key)) out.add(`${REPO_PREFIX}${key}`);
  }
  const priority = sections.get("priority")?.toLowerCase();
  if (priority === "p1" || priority === "p2") out.add(`priority:${priority}`);
  return [...out];
}

export function planIssueSync(issue: LiveIssue, event: IssueEvent): IssuePlan {
  const status = desiredStatus(issue);
  const labels = statusLabelDiff(issue.labels, status);
  const { keys, unknown } = repoKeysOf(issue.labels);
  const warnings = unknown.map((l) => `unknown repo label ${l}`);
  const assigned = issue.assignees.length > 0;

  const trigger =
    labels.add.includes(STATUS_META["in-progress"].label) ||
    event.action === "opened" ||
    event.action === "assigned" ||
    event.action === "reopened" ||
    (event.action === "labeled" &&
      event.label !== null &&
      (event.label.startsWith(REPO_PREFIX) || event.label.startsWith(STATUS_PREFIX)));

  const wantsBranches = status === "in-progress" && assigned && trigger;
  if (wantsBranches && keys.length === 0) warnings.push("assigned but no repo:* label, no branch created");

  return {
    status,
    labels,
    closeIssue: status === "done" && issue.state === "open",
    ensureBranchesIn: wantsBranches ? keys : [],
    ticketType: ticketTypeOf(issue.labels),
    warnings,
  };
}

export function extractJiraKey(text: string): string | null {
  return JIRA_KEY_RE.exec(text)?.[1]?.toUpperCase() ?? null;
}

export function planPrSync(pr: PrState): PrPlan {
  const key = extractJiraKey(pr.headRef) ?? (pr.state === "open" ? extractJiraKey(pr.title) : null);
  if (key === null) return { key, status: null };
  if (pr.merged) return { key, status: pr.baseRef === pr.defaultBranch ? "done" : null };
  if (pr.state === "closed" || pr.draft) return { key, status: "in-progress" };
  return { key, status: "in-review" };
}

export function mergeOutcome(repoLabelCount: number): MergeOutcome {
  return repoLabelCount <= 1 ? "close" : "comment";
}

export function slugify(title: string, maxLength: number = CONFIG.slugMaxLength): string {
  const trim = (s: string): string => s.replace(/^-+|-+$/g, "");
  const full = trim(
    title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  );
  const cutSlug = full.slice(0, maxLength);
  const cut = cutSlug.lastIndexOf("-");
  const slug = full.length <= maxLength ? full : trim(cut > 0 ? cutSlug.slice(0, cut) : cutSlug);
  return slug === "" ? "ticket" : slug;
}

export function branchName(type: TicketType, key: string, title: string): string {
  return `${type}/${key}-${slugify(title)}`;
}

export function jiraKeyFromBody(body: string): string | null {
  return MARKER_RE.exec(body)?.[1] ?? null;
}

export function withJiraMarker(body: string, key: string): string {
  const marker = jiraMarker(key);
  if (MARKER_RE.test(body)) return body.replace(MARKER_RE_ALL, marker);
  const trimmed = body.trimEnd();
  return trimmed === "" ? marker : `${trimmed}\n\n${marker}`;
}

export function stripJiraMarker(body: string): string {
  return body.replace(MARKER_RE_ALL, "").trimEnd();
}

export function jiraSummary(title: string): string {
  return title.length > 255 ? `${title.slice(0, 254)}…` : title;
}

export function jiraDescription(issue: Pick<LiveIssue, "number" | "body" | "htmlUrl">): string {
  const source = `Source of truth: [GitHub #${issue.number}|${issue.htmlUrl}]`;
  const stripped = stripJiraMarker(issue.body);
  const body = stripped.length > 30000 ? `${stripped.slice(0, 30000)}\n\n(truncated, see GitHub)` : stripped;
  return body === "" ? source : `${body}\n\n${source}`;
}

export function jiraLabels(issueNumber: number, repoKeys: readonly RepoKey[]): string[] {
  return [`gh-${issueNumber}`, ...repoKeys.map((k) => `repo-${k}`)];
}

export function branchesComment(entries: readonly BranchEntry[]): string {
  const bullets = entries.map((e) => `- \`${e.repo}\`: \`${e.branch}\`${e.created ? " (created)" : ""}`);
  const switches = [...new Set(entries.map((e) => e.branch))].map((b) => `git fetch origin && git switch ${b}`);
  return [
    MARKERS.branchesComment,
    "**Branches**",
    "",
    ...bullets,
    "",
    "```bash",
    ...switches,
    "```",
  ].join("\n");
}

export function prCommentMarker(repo: string, prNumber: number): string {
  return `<!-- ticket-sync:pr:${repo}#${prNumber} -->`;
}
