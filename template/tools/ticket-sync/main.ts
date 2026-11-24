import { appendFileSync, readFileSync } from "node:fs";
import { CONFIG, JIRA_TYPE, MARKERS, STATUS_META } from "./config.ts";
import type { RepoKey, TicketType } from "./config.ts";
import {
  branchesComment,
  branchName,
  formLabels,
  jiraDescription,
  jiraKeyFromBody,
  jiraLabels,
  jiraSummary,
  mergeOutcome,
  planIssueSync,
  planPrSync,
  prCommentMarker,
  repoKeysOf,
  statusLabelDiff,
  statusOfLabel,
  ticketTypeOf,
  withJiraMarker,
} from "./core.ts";
import type { BranchEntry, IssueAction, IssueEvent, LiveIssue } from "./core.ts";
import { createGitHub } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import { createJira } from "./jira.ts";
import type { JiraClient } from "./jira.ts";

export interface Deps {
  readonly hub: GitHubClient; // GITHUB_TOKEN; its writes do not retrigger workflows
  readonly bot: GitHubClient | null; // KB_BOT_TOKEN; cross-repo branches, project, PR-driven hub writes
  readonly jira: JiraClient | null;
  readonly projectNumber: number | null; // KB_PROJECT_NUMBER
  readonly hubRepo: string;
}

export interface RunReport {
  readonly lines: string[]; // markdown bullet lines for GITHUB_STEP_SUMMARY
  readonly warnings: string[];
  readonly errors: string[]; // non-empty => exit code 1
}

const ISSUE_ACTIONS = [
  "opened", "edited", "reopened", "closed", "assigned", "unassigned", "labeled", "unlabeled",
] as const satisfies readonly IssueAction[];
const PR_ACTIONS: readonly string[] = ["opened", "reopened", "ready_for_review", "converted_to_draft", "closed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssueAction(value: unknown): value is IssueAction {
  return typeof value === "string" && (ISSUE_ACTIONS as readonly string[]).includes(value);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function newReport(): RunReport {
  return { lines: [], warnings: [], errors: [] };
}

/** Runs one step; a throw becomes a report error (result null) and the run continues. */
async function attempt<T>(report: RunReport, what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    report.errors.push(`${what}: ${errText(e)}`);
    return null;
  }
}

async function step(report: RunReport, what: string, fn: () => Promise<void>): Promise<void> {
  await attempt(report, what, fn);
}

interface JiraOutcome {
  readonly key: string | null;
  readonly created: boolean;
}

async function syncJiraKey(
  deps: Deps,
  jira: JiraClient,
  issue: LiveIssue,
  ticketType: TicketType,
  repoKeys: readonly RepoKey[],
  report: RunReport,
): Promise<JiraOutcome> {
  const marker = jiraKeyFromBody(issue.body);
  const owned =
    marker !== null && (await jira.ghNumberForKey(marker)) === issue.number ? marker : null;
  if (marker !== null && owned === null) {
    report.warnings.push(`marker ${marker} does not belong to #${issue.number}; ignored`);
  }
  const found = owned ?? (await jira.findKeyByGhNumber(issue.number));
  const key =
    found ??
    (await jira.create({
      summary: jiraSummary(issue.title),
      description: jiraDescription(issue),
      issueType: JIRA_TYPE[ticketType],
      labels: jiraLabels(issue.number, repoKeys),
    }));
  if (found === null) {
    report.lines.push(`jira: ${key} created`);
    // A sprint failure is only a warning: the issue already exists, and a missing sprint is fixed by dragging.
    try {
      const sprint = await jira.addToActiveSprint(key);
      report.lines.push(sprint === null ? "jira: no active sprint; left in backlog" : `jira: ${key} added to sprint ${sprint}`);
    } catch (e) {
      report.warnings.push(`jira sprint: ${key} left in backlog: ${errText(e)}`);
    }
  }
  if (key !== marker) {
    const fresh = await deps.hub.getIssue(deps.hubRepo, issue.number);
    await deps.hub.updateBody(deps.hubRepo, issue.number, withJiraMarker(fresh.body, key));
    report.lines.push(`jira: marker ${key} written to #${issue.number}`);
  }
  return { key, created: found === null };
}

async function ensureBranches(
  deps: Deps,
  bot: GitHubClient,
  issue: LiveIssue,
  key: string,
  ticketType: TicketType,
  repoKeys: readonly RepoKey[],
  report: RunReport,
): Promise<void> {
  const linked = await bot.linkedBranches(issue.nodeId);
  const entries: BranchEntry[] = [];
  for (const k of repoKeys) {
    await step(report, `branch ${k}`, async () => {
      const repo = CONFIG.repos[k];
      if (repo === undefined) throw new Error(`repo:${k} is not in workflow.config.json repos`);
      const existing = linked.find((l) => l.repo === repo && l.branch.includes(`/${key}-`));
      if (existing) {
        entries.push({ ...existing, created: false });
        return;
      }
      const branch = branchName(ticketType, key, issue.title);
      if (await bot.branchExists(repo, branch)) {
        entries.push({ repo, branch, created: false });
        return;
      }
      await bot.createLinkedBranch(issue.nodeId, await bot.getRepo(repo), branch);
      entries.push({ repo, branch, created: true });
      report.lines.push(`branch ${repo}: ${branch} created`);
    });
  }
  if (entries.length > 0) {
    await deps.hub.upsertComment(deps.hubRepo, issue.number, MARKERS.branchesComment, branchesComment(entries));
  }
}

export async function runIssueEvent(deps: Deps, payload: unknown): Promise<RunReport> {
  const report = newReport();
  const rawIssue = isRecord(payload) ? payload["issue"] : undefined;
  if (!isRecord(payload) || !isRecord(rawIssue) || typeof rawIssue["number"] !== "number") {
    report.errors.push("malformed issues payload");
    return report;
  }
  if (rawIssue["pull_request"] !== undefined) {
    report.lines.push("skipped: pull request");
    return report;
  }
  const action = payload["action"];
  if (!isIssueAction(action)) {
    report.warnings.push(`unsupported issues action ${String(action)}`);
    return report;
  }
  const rawLabel = payload["label"];
  const event: IssueEvent = {
    action,
    label: isRecord(rawLabel) && typeof rawLabel["name"] === "string" ? rawLabel["name"] : null,
  };
  const n = rawIssue["number"];
  const { hub, bot, jira, hubRepo } = deps;

  const live = await hub.getIssue(hubRepo, n).catch((e: unknown) => {
    report.errors.push(`getIssue #${n}: ${errText(e)}`);
    return null;
  });
  if (live === null) return report;

  const missing = action === "opened" ? formLabels(live.body).filter((l) => !live.labels.includes(l)) : [];
  const added =
    missing.length > 0 &&
    (await attempt(report, "form labels", () => hub.addLabels(hubRepo, n, missing).then(() => true))) === true;
  if (added) report.lines.push(`labels from form: ${missing.join(", ")}`);
  const issue: LiveIssue = added ? { ...live, labels: [...live.labels, ...missing] } : live;

  const ticketType = ticketTypeOf(issue.labels);
  const repoKeys = repoKeysOf(issue.labels).keys;

  if (!jira) report.warnings.push("Jira skipped: JIRA_EMAIL / JIRA_API_TOKEN not set");
  const jiraOut: JiraOutcome =
    (jira && (await attempt(report, "jira", () => syncJiraKey(deps, jira, issue, ticketType, repoKeys, report)))) ||
    { key: null, created: false };
  const { key, created } = jiraOut;

  const plan = planIssueSync(issue, event);
  report.warnings.push(...plan.warnings);

  await step(report, "labels", async () => {
    if (plan.labels.add.length > 0) await hub.addLabels(hubRepo, n, plan.labels.add);
    for (const l of plan.labels.remove) await hub.removeLabel(hubRepo, n, l);
    if (plan.labels.add.length + plan.labels.remove.length > 0) {
      const from = plan.labels.remove.map(statusOfLabel).find((s) => s !== null) ?? "none";
      report.lines.push(`status: ${from} -> ${plan.status}`);
    }
  });

  if (plan.closeIssue) {
    await step(report, "close issue", async () => {
      await hub.closeIssue(hubRepo, n);
      report.lines.push(`closed #${n}`);
    });
  }

  if (bot && deps.projectNumber !== null) {
    const projectNumber = deps.projectNumber;
    await step(report, "board", async () => {
      await bot.setProjectStatus(projectNumber, issue.nodeId, STATUS_META[plan.status].board);
      report.lines.push(`board: ${STATUS_META[plan.status].board}`);
    });
  } else {
    report.warnings.push(
      `board sync skipped: ${bot ? "KB_PROJECT_NUMBER" : "KB_BOT_TOKEN"} not set`,
    );
  }

  if (jira && key !== null) {
    const jiraKey: string = key;
    await step(report, "jira transition", async () => {
      const name = STATUS_META[plan.status].jira;
      const result = await jira.transition(jiraKey, name);
      if (result === "not-found") {
        report.warnings.push(
          `Jira has no transition to "${name}" for ${jiraKey}; add that status to the ${CONFIG.jiraProjectKey} board`,
        );
      } else if (result === "transitioned") {
        report.lines.push(`jira: ${jiraKey} -> ${name}`);
      }
    });
    if (!created) {
      await step(report, "jira update", async () => {
        await jira.update(jiraKey, {
          summary: jiraSummary(issue.title),
          description: jiraDescription(issue),
          labels: jiraLabels(n, repoKeys),
        });
        report.lines.push(`jira: ${jiraKey} updated`);
      });
    }
  }

  if (plan.ensureBranchesIn.length > 0) {
    if (bot && key !== null) {
      const jiraKey: string = key;
      await step(report, "branches", () =>
        ensureBranches(deps, bot, issue, jiraKey, ticketType, plan.ensureBranchesIn, report),
      );
    } else {
      report.warnings.push(
        `branches skipped: needs ${bot ? "a Jira key" : "KB_BOT_TOKEN"}`,
      );
    }
  }
  return report;
}

export async function runPullRequestEvent(deps: Deps, payload: unknown): Promise<RunReport> {
  const report = newReport();
  const rawPr = isRecord(payload) ? payload["pull_request"] : undefined;
  const rawRepo = isRecord(payload) ? payload["repository"] : undefined;
  if (
    !isRecord(payload) || !isRecord(rawPr) || !isRecord(rawRepo) ||
    typeof rawPr["number"] !== "number" || typeof rawRepo["name"] !== "string" ||
    typeof payload["action"] !== "string"
  ) {
    report.errors.push("malformed pull_request payload");
    return report;
  }
  if (!PR_ACTIONS.includes(payload["action"])) {
    report.lines.push("ignored");
    return report;
  }
  const { bot, jira, hubRepo } = deps;
  if (!bot || !jira) {
    report.errors.push("pr sync needs KB_BOT_TOKEN and Jira credentials");
    return report;
  }
  const repoName = rawRepo["name"];
  const prNumber = rawPr["number"];
  await step(report, "pull request", async () => {
    const pr = await bot.getPullRequest(repoName, prNumber);
    const plan = planPrSync(pr);
    if (plan.key === null) {
      report.lines.push(`no ${CONFIG.jiraProjectKey} key`);
      return;
    }
    if (plan.status === null) {
      report.lines.push(`merged into ${pr.baseRef}, not the default branch; no change`);
      return;
    }
    const n = await jira.ghNumberForKey(plan.key);
    if (n === null) {
      report.warnings.push(`no hub issue for ${plan.key}`);
      return;
    }
    const issue = await bot.getIssue(hubRepo, n);
    const marker = prCommentMarker(repoName, prNumber);
    if (plan.status === "done") {
      if (mergeOutcome(repoKeysOf(issue.labels).keys.length) === "close") {
        await bot.upsertComment(hubRepo, n, marker, `${marker}\nMerged in ${pr.htmlUrl}`);
        if (issue.state === "open") await bot.closeIssue(hubRepo, n);
        report.lines.push(`${plan.key}: merged, closed #${n}`);
      } else {
        await bot.upsertComment(
          hubRepo, n, marker,
          `${marker}\nMerged ${pr.htmlUrl}. This ticket spans several repos; close it when all are merged.`,
        );
        report.lines.push(`${plan.key}: merged, #${n} left open (several repos)`);
      }
      return;
    }
    const diff = statusLabelDiff(issue.labels, plan.status);
    if (diff.add.length === 0 && diff.remove.length === 0) {
      report.lines.push(`already ${plan.status}`);
      return;
    }
    if (diff.add.length > 0) await bot.addLabels(hubRepo, n, diff.add);
    for (const l of diff.remove) await bot.removeLabel(hubRepo, n, l);
    report.lines.push(`${plan.key}: #${n} status -> ${plan.status}`);
  });
  return report;
}

function buildDeps(env: NodeJS.ProcessEnv): Deps {
  const token = env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const botToken = env["KB_BOT_TOKEN"];
  const email = env["JIRA_EMAIL"];
  const apiToken = env["JIRA_API_TOKEN"];
  const project = Number.parseInt(env["KB_PROJECT_NUMBER"] ?? "", 10);
  return {
    hub: createGitHub(token, CONFIG.owner),
    bot: botToken ? createGitHub(botToken, CONFIG.owner) : null,
    jira:
      email && apiToken
        ? createJira({
            baseUrl: env["JIRA_BASE_URL"] || CONFIG.jiraBaseUrl,
            email,
            apiToken,
            projectKey: CONFIG.jiraProjectKey,
          })
        : null,
    projectNumber: Number.isInteger(project) ? project : null,
    hubRepo: CONFIG.hubRepo,
  };
}

async function main(): Promise<void> {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const payload: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  const deps = buildDeps(process.env);
  const report =
    eventName === "issues"
      ? await runIssueEvent(deps, payload)
      : eventName === "pull_request"
        ? await runPullRequestEvent(deps, payload)
        : { ...newReport(), warnings: [`unsupported event ${eventName}`] };
  const markdown = [
    ...report.lines.map((l) => `- ${l}`),
    ...report.warnings.map((w) => `- warning: ${w}`),
    ...report.errors.map((e) => `- error: ${e}`),
  ].join("\n");
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
  else console.log(markdown);
  for (const w of report.warnings) console.log(`::warning::${w}`);
  for (const e of report.errors) console.log(`::error::${e}`);
  if (report.errors.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.log(`::error::${errText(e)}`);
    process.exitCode = 1;
  });
}
