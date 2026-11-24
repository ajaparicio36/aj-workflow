#!/usr/bin/env bash
# One-time GitHub setup for the ticket workflow. Safe to re-run. Names come from workflow.config.json.
#   bash kit/scripts/bootstrap-github.sh                 # everything, prompts for secrets
#   bash kit/scripts/bootstrap-github.sh --skip-secrets  # labels, project, vars, access only
# Windows PowerShell: & "C:\Program Files\Git\bin\bash.exe" kit/scripts/bootstrap-github.sh
#   (plain `bash` in PowerShell is WSL's launcher, not Git Bash)
# Needs: gh logged in as an org admin with scopes repo, workflow, project
#   gh auth refresh -h github.com -s project
# GitHub Free orgs cannot share org-level secrets with private repos,
# so secrets and variables are set per repo (hub + every code repo).
set -euo pipefail
cd "$(dirname "$0")/../.."

cfg() { node -e "const c=JSON.parse(require('fs').readFileSync('workflow.config.json','utf8'));const v=($1);console.log(Array.isArray(v)?v.join(' '):(v??''))"; }
OWNER="$(cfg c.owner)"
HUB="$(cfg c.hub)"
read -r -a CODE_REPOS <<< "$(cfg 'Object.values(c.repos).filter(r=>r!==c.hub)')"
ALL_REPOS=("$HUB" "${CODE_REPOS[@]}")
PROJECT_TITLE="$(cfg c.name)"
JIRA_BASE_URL="$(cfg 'c.jira&&c.jira.baseUrl')"
SKIP_SECRETS=0
[ "${1:-}" = "--skip-secrets" ] && SKIP_SECRETS=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*"; }

say "1/7  gh auth"
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
scopes="$(gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: //p')"
ok "scopes: $scopes"
HAS_PROJECT=1
case ", $scopes," in *", project,"*) ;; *) HAS_PROJECT=0; warn "missing 'project' scope: gh auth refresh -h github.com -s project  (board steps skipped)";; esac

say "2/7  Labels on $OWNER/$HUB"
label() { gh label create "$1" --repo "$OWNER/$HUB" --color "$2" --description "$3" --force >/dev/null && ok "$1"; }
label "status:todo"        "ededed" "Not started"
label "status:in-progress" "1d76db" "Claimed, branch cut"
label "status:in-review"   "fbca04" "PR open"
label "status:done"        "0e8a16" "Merged and verified"
label "type:feat"     "a2eeef" "New behaviour"
label "type:fix"      "d73a4a" "Bug fix"
label "type:chore"    "cfd3d7" "Tooling, deps, setup"
label "type:refactor" "c5def5" "No behaviour change"
label "type:docs"     "0075ca" "Docs, ADRs"
label "type:design"   "f9d0c4" "UX/UI design work"
while read -r key repo; do label "repo:$key" "5319e7" "$repo"; done < <(cfg 'Object.entries(c.repos).map(([k,r])=>k+" "+r).join("\n")')
label "priority:p1" "b60205" "Do next"
label "priority:p2" "e99695" "Normal"
label "blocked"     "000000" "Waiting on a person or decision; comment says who"
label "needs-triage"    "d4c5f9" "Triage: maintainer needs to evaluate"
label "needs-info"      "d4c5f9" "Triage: waiting on reporter"
label "ready-for-agent" "0e8a16" "Triage: fully specified, AFK agent can take it"
label "ready-for-human" "1d76db" "Triage: needs human implementation"
label "wontfix"         "ffffff" "Triage: will not be actioned"

say "3/7  Project board"
PROJECT_NUMBER=""
if [ "$HAS_PROJECT" = 1 ]; then
  PROJECT_NUMBER="$(gh project list --owner "$OWNER" --format json --limit 100 --jq ".projects[] | select(.title==\"$PROJECT_TITLE\") | .number" | head -1)"
  if [ -z "$PROJECT_NUMBER" ]; then
    PROJECT_NUMBER="$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq .number)"
    ok "created project #$PROJECT_NUMBER"
  else
    ok "project #$PROJECT_NUMBER exists"
  fi
  field_id="$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq '.fields[] | select(.name=="Status") | .id')"
  current="$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq '[.fields[] | select(.name=="Status") | .options[].name] | join("|")')"
  if [ "$current" = "To Do|In Progress|In Review|Done" ]; then
    ok "Status options already To Do / In Progress / In Review / Done"
  else
    # Replaces the options (and their ids). Items keep no Status value; ticket-sync re-sets it on the next event.
    gh api graphql -f query='mutation($id: ID!) { updateProjectV2Field(input: {
        fieldId: $id,
        singleSelectOptions: [
          {name: "To Do", color: GRAY, description: "Not started"},
          {name: "In Progress", color: BLUE, description: "Claimed, branch cut"},
          {name: "In Review", color: YELLOW, description: "PR open"},
          {name: "Done", color: GREEN, description: "Merged and verified"}
        ]}) { projectV2Field { ... on ProjectV2SingleSelectField { name } } } }' -f id="$field_id" >/dev/null
    ok "Status options set (was: ${current:-none})"
  fi
  for r in "${ALL_REPOS[@]}"; do
    gh project link "$PROJECT_NUMBER" --owner "$OWNER" --repo "$OWNER/$r" >/dev/null 2>&1 && ok "linked $r" || ok "$r already linked"
  done
else
  warn "skipped (no project scope)"
fi

say "4/7  Hub reusable workflow access"
if gh api -X PUT "repos/$OWNER/$HUB/actions/permissions/access" -f access_level=organization >/dev/null 2>&1; then
  ok "$HUB workflows callable from org repos"
else
  warn "could not set Actions access; set it in $HUB > Settings > Actions > General > Access"
fi

say "5/7  Variables"
[ -n "$JIRA_BASE_URL" ] || warn "no jira.baseUrl in workflow.config.json; Jira sync stays off"
[ -z "$JIRA_BASE_URL" ] || for r in "${ALL_REPOS[@]}"; do
  gh variable set JIRA_BASE_URL --repo "$OWNER/$r" --body "$JIRA_BASE_URL" >/dev/null && ok "$r JIRA_BASE_URL"
done
if [ -n "$PROJECT_NUMBER" ]; then
  gh variable set KB_PROJECT_NUMBER --repo "$OWNER/$HUB" --body "$PROJECT_NUMBER" >/dev/null && ok "$HUB KB_PROJECT_NUMBER=$PROJECT_NUMBER"
fi

say "6/7  Secrets (per repo)"
set_secret() { # $1 name  $2 prompt
  local have=1 r value
  for r in "${ALL_REPOS[@]}"; do
    gh secret list --repo "$OWNER/$r" --json name --jq '.[].name' | grep -qx "$1" || have=0
  done
  if [ "$have" = 1 ]; then ok "$1 already set in all repos (re-set with: gh secret set $1 --repo $OWNER/<repo>)"; return; fi
  printf '  %s: ' "$2"; read -rs value; echo
  [ -n "$value" ] || { warn "$1 empty, skipped"; return; }
  for r in "${ALL_REPOS[@]}"; do printf '%s' "$value" | gh secret set "$1" --repo "$OWNER/$r" >/dev/null && ok "$r $1"; done
}
if [ "$SKIP_SECRETS" = 1 ] || [ ! -t 0 ]; then
  warn "skipped (--skip-secrets or no terminal). Re-run in a terminal to set KB_BOT_TOKEN, JIRA_EMAIL, JIRA_API_TOKEN."
else
  echo "  KB_BOT_TOKEN: PAT of a maintainer. Fine-grained: owner $OWNER, repos $HUB ${CODE_REPOS[*]},"
  echo "    Contents RW, Issues RW, Pull requests R, Metadata R, org Projects RW. Classic alternative: repo + project."
  echo "  JIRA_API_TOKEN: https://id.atlassian.com/manage-profile/security/api-tokens (same account as JIRA_EMAIL)."
  set_secret KB_BOT_TOKEN "KB_BOT_TOKEN (hidden)"
  [ -z "$JIRA_BASE_URL" ] || set_secret JIRA_EMAIL "JIRA_EMAIL, the Atlassian account email (hidden)"
  [ -z "$JIRA_BASE_URL" ] || set_secret JIRA_API_TOKEN "JIRA_API_TOKEN (hidden)"
fi

say "7/7  Next"
echo "  - Push $HUB main (workflows only run from the default branch)."
echo "  - Copy kit/github/ticket-status.yml to .github/workflows/ in ${CODE_REPOS[*]} and push."
echo "  - Jira ACME needs an 'In Review' status (docs/workflow.md, Jira section)."
echo "  - Install the GitHub for Jira app on the org so ACME-<n> branches/PRs show in Jira's dev panel."
