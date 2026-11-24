#!/usr/bin/env node
// Scaffolds an aj-workflow hub into a workspace. Zero dependencies; Node 24+ and git.
//   node setup.mjs --config answers.json [--workspace <dir>] [--template <dir>]
//   node setup.mjs                       (asks the questions in the terminal)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const REPO_URL = "https://github.com/ajaparicio36/aj-workflow.git";
const ROLES = ["lead", "researcher", "redteam", "rescue", "worker"];
const CLAUDE_DEFAULTS = { lead: "opus", researcher: "haiku", redteam: "fable", rescue: "fable", worker: "sonnet" };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** The template comes from this repo's checkout when the script runs inside it, else from a shallow clone. */
function findTemplate(explicit) {
  if (explicit) return path.resolve(explicit);
  const local = path.resolve(import.meta.dirname, "..", "..", "..", "template");
  if (fs.existsSync(path.join(local, "workflow.config.json"))) return local;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aj-workflow-"));
  console.log(`Fetching the template from ${REPO_URL}`);
  execFileSync("git", ["clone", "--depth", "1", REPO_URL, tmp], { stdio: "inherit" });
  return path.join(tmp, "template");
}

async function interview() {
  // The async iterator buffers lines, so piped answers are not lost between questions.
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q, def = "") => {
    process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
    const { value, done } = await lines.next();
    return (done ? "" : value.trim()) || def;
  };
  const name = await ask("Project name (display)");
  const owner = await ask("GitHub owner (org or user)");
  const hub = await ask("Hub repo name", `${owner}-kb`);
  const reposRaw = await ask("Code repos as key=repo, comma separated (e.g. api=zeta-api,mobile=zeta-mobile)");
  const ticketKey = (await ask("Ticket key (2-10 capitals, same as the Jira project key)")).toUpperCase();
  const jira = await ask("Jira site URL, or none", "none");
  const agents = (await ask("Agents: any of claude, codex, opencode", "claude")).split(/[\s,]+/).filter(Boolean);
  const mode = await ask("How work runs: orchestrated or solo", "orchestrated");
  const models = {};
  for (const agent of agents) {
    models[agent] = {};
    for (const role of mode === "solo" ? ["lead"] : ROLES) {
      models[agent][role] = await ask(`${agent} model for ${role} (blank = agent default)`, agent === "claude" ? CLAUDE_DEFAULTS[role] : "");
    }
  }
  rl.close();
  const repos = Object.fromEntries(reposRaw.split(",").map((p) => p.split("=").map((s) => s.trim())).filter(([k, v]) => k && v));
  return { name, owner, hub, ticketKey, repos, ...(jira === "none" ? {} : { jira: { baseUrl: jira } }), agents, mode, models };
}

/** Puts the hub in the repo map as `kb` (unless already there) and fills Claude defaults in. */
export function normalise(answers) {
  const c = structuredClone(answers);
  c.repos ??= {};
  if (!Object.values(c.repos).includes(c.hub)) c.repos.kb = c.hub;
  c.models ??= {};
  if (c.agents?.includes("claude")) c.models.claude = { ...CLAUDE_DEFAULTS, ...Object.fromEntries(Object.entries(c.models.claude ?? {}).filter(([, v]) => v)) };
  if (c.jira && !c.jira.baseUrl) delete c.jira;
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(c.ticketKey ?? "")) throw new Error(`ticketKey "${c.ticketKey}" must be 2-10 capital letters or digits, starting with a letter`);
  if (!/^[A-Za-z0-9_.-]+$/.test(c.hub ?? "")) throw new Error(`hub "${c.hub}" is not a valid repo name`);
  if (/['"`\\]/.test(c.name ?? "")) throw new Error(`name "${c.name}" must not contain quotes or backslashes (it lands in YAML and Markdown)`);
  return c;
}

/** Swaps the template's sample names (acme, Acme, ACME, acme-kb) for the project's. */
export function rename(text, c) {
  const jiraHost = c.jira ? new URL(c.jira.baseUrl).host : "your-site.atlassian.net";
  return text
    .replaceAll("acme.atlassian.net", jiraHost)
    .replaceAll("acme-kb", "\u0000HUB\u0000")
    .replaceAll("ACME", c.ticketKey)
    .replaceAll("Acme", c.name)
    .replaceAll("acme", c.owner)
    .replaceAll("\u0000HUB\u0000", c.hub);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(p, out); } else out.push(p);
  }
  return out;
}

export async function setup(answers, workspace, templateDir) {
  const c = normalise(answers);
  const template = findTemplate(templateDir);
  const { readConfig } = await import(pathToFileURL(path.join(template, "kit", "install.mjs")).href);
  const dest = path.join(workspace, c.hub);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${dest} exists and is not empty; pick another hub name or move it`);

  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, dest, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
  fs.writeFileSync(path.join(dest, "workflow.config.json"), `${JSON.stringify(c, null, 2)}\n`);
  readConfig(path.join(dest, "workflow.config.json"));

  // tools/ keeps the sample names: its tests run against their own fixture config.
  for (const file of walk(dest)) {
    const rel = path.relative(dest, file).split(path.sep).join("/");
    if (rel.startsWith("tools/") || rel === "workflow.config.json") continue;
    const text = fs.readFileSync(file, "utf8");
    const next = rename(text, c);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const keys = Object.keys(c.repos);
  for (const form of ["bug.yml", "task.yml"]) {
    const p = path.join(dest, ".github", "ISSUE_TEMPLATE", form);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/options: \[[^\]]*kb\]/, `options: [${keys.join(", ")}]`));
  }
  const agentsMd = path.join(dest, "AGENTS.md");
  const rows = Object.entries(c.repos).map(([k, r]) =>
    r === c.hub ? `| \`${r}\` | Hub: tickets, ADRs, notes, agent kit, ticket-sync (\`repo:${k}\`) | Node 24 TS scripts |` : `| \`${r}\` | describe it (\`repo:${k}\`) | fill in |`);
  fs.writeFileSync(agentsMd, fs.readFileSync(agentsMd, "utf8").replace(
    /(<!-- aj:map:start -->\n)[\s\S]*?(\n<!-- aj:map:end -->)/,
    (_m, a, b) => `${a}| Folder | What | Stack |\n|---|---|---|\n${rows.join("\n")}${b}`));

  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dest });
  } catch {
    console.log("  WARN git init failed; run it in the hub, then node kit/install.mjs");
  }
  const { install } = await import(pathToFileURL(path.join(dest, "kit", "install.mjs")).href);
  install(path.resolve(workspace));
  return { dest, config: c };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const configPath = arg("config");
  const answers = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : await interview();
  const { dest, config } = await setup(answers, path.resolve(arg("workspace") ?? process.cwd()), arg("template"));
  const codeRepos = Object.values(config.repos).filter((r) => r !== config.hub);
  console.log(`
setup complete: ${dest}

Next (only you can do these):
  1. Create ${config.owner}/${config.hub}${codeRepos.length ? ` and ${codeRepos.join(", ")}` : ""} on GitHub. In the hub: git add -A && git commit -m "chore: scaffold from aj-workflow" && git remote add origin <url> && git push -u origin main
  2. In the hub: bash kit/scripts/bootstrap-github.sh   (Windows: Git Bash, not WSL)
  3. ${config.jira ? `Copy kit/github/ticket-status.yml into .github/workflows/ of ${codeRepos.join(", ") || "each code repo"}` : "Skip kit/github/ticket-status.yml: without Jira, PR sync fails every PR"}
  4. ${config.jira ? "Jira: add an In Review status to the board; install GitHub for Jira on the org" : "No Jira: branch cutting and PR-driven status stay off (they need the Jira key)"}
  5. Start agent sessions in ${path.dirname(dest)}, then try /ticket new and /dev`);
}
