// Decides which App CI jobs a change needs (#231). Deliberately conservative: a path this file does not
// recognise, an empty or failed diff, a push to main, a manual run, and any change to a workflow, package.json
// or the lockfile all run everything. Every diff, including docs-only, reaches the secret scanner.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const everything = [
  /^\.github\/workflows\//,
  /^package(?:-lock)?\.json$/,
  /^\.nvmrc$/,
  // The classifier itself: a PR that edits it could otherwise mark its own jobs as unneeded.
  /^\.github\/scripts\/ci-changes(?:\.test)?\.mjs$/,
];
const app = [
  /^apps\//, /^packages\//, /^config\//, /^scripts\//, /^tests\/fixtures\//,
  /^tsconfig[^/]*\.json$/, /^(?:babel|metro|app)\.config\.[cm]?[jt]s$/, /^\.env\.example$/,
];
// tests/fixtures is also imported by package unit tests, so it is listed with the app paths.
const browser = [/^tests\/browser\//];
const db = [/^supabase\/migrations\//, /^supabase\/seed\.sql$/, /^tests\/database\//];
const functions = [/^supabase\/functions\//];
// Node tests that read repository files: policy scripts, the committed Supabase config and policy files, the ruleset proposal.
const scripts = [/^\.github\/scripts\//, /^supabase\/(?:config(?:\.local)?\.toml|migration-policy\.json)$/, /^docs\/policy\//, /^\.github\/CODEOWNERS$/];
// Safe to skip every job: prose, agent instructions and templates that no test or build reads.
const docs = [
  /^docs\/(?!policy\/)/, /(?:^|\/)README(?:\.md)?$/i, /^(?:apps|packages|supabase)\/.*\/README\.md$/, /^AGENTS\.md$/, /^\.agents\//, /^\.codex\//,
  /^\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\.md$)/, /^\.gitignore$/, /^[^/]+\.md$/,
];

const matches = (patterns, file) => patterns.some(pattern => pattern.test(file));
const allFlags = { secrets: true, static_analysis: true, app: true, browser: true, db: true, functions: true, scripts: true, workflows: true, docs_only: false, all: true };

export function classify(files, { event = 'pull_request' } = {}) {
  if (event !== 'pull_request' || !files.length) return { ...allFlags };
  const flags = { secrets: true, static_analysis: false, app: false, browser: false, db: false, functions: false, scripts: false, workflows: false, docs_only: false, all: false };
  let unknown = false;
  let docsOnly = true;
  for (const file of files) {
    if (matches(everything, file)) {
      flags.all = true;
      if (file.startsWith('.github/workflows/')) flags.workflows = true;
      docsOnly = false;
      continue;
    }
    // Docs win over the area patterns, so a README inside packages/ does not trigger a build.
    if (matches(docs, file)) continue;
    docsOnly = false;
    const known = [[app, 'app'], [browser, 'browser'], [db, 'db'], [functions, 'functions'], [scripts, 'scripts']]
      .filter(([patterns]) => matches(patterns, file));
    for (const [, name] of known) flags[name] = true;
    if (!known.length) unknown = true;
  }
  if (unknown) flags.all = true;
  if (flags.all) return { ...allFlags, workflows: flags.workflows };
  if (flags.app) flags.browser = true;
  flags.static_analysis = flags.app || flags.scripts || flags.functions;
  flags.docs_only = docsOnly;
  return flags;
}

function changedFiles(base) {
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? 'pull_request';
  const base = process.env.BASE_SHA;
  const files = event === 'pull_request' && base ? changedFiles(base) : [];
  const flags = classify(files, { event });
  const lines = Object.entries(flags).map(([name, value]) => `${name}=${value}`);
  console.log(`event=${event} changed files=${files.length}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Change detection\n\n${files.length} changed files (${event})\n\n| Flag | Value |\n| --- | --- |\n${Object.entries(flags).map(([name, value]) => `| ${name} | ${value} |`).join('\n')}\n\n`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes('--files')) {
    // Local use: node ci-changes.mjs --files a b c
    const files = process.argv.slice(process.argv.indexOf('--files') + 1);
    console.log(JSON.stringify(classify(files)));
  } else main();
}
