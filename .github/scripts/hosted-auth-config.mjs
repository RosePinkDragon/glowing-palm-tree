import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// Strict, fail-closed reader for supabase/config.toml. It accepts only: blank lines, comment lines, [table.headers]
// (bare or "double-quoted" segments), and `key = value` where value is a "string", true, false, an integer or a
// single-line array of strings/integers, each optionally followed by a # comment. Anything else throws, so a construct
// this reader does not understand (multi-line strings, single quotes, inline tables, dotted keys, [[arrays]],
// duplicates) can never hide a setting from the checks below.
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const BARE = '[A-Za-z0-9_-]+';
const QUOTED = '"[^"\'\\\\\\n]*"';
const SEGMENT = `(?:${BARE}|${QUOTED})`;
const HEADER = new RegExp(`^\\[(${SEGMENT}(?:\\.${SEGMENT})*)\\]\\s*(?:#.*)?$`);
const KEY = `(?:${BARE}|${QUOTED})`;
const STRING = '"(?:[^"\\\\\\n]|\\\\.)*"';
const ITEM = `(?:${STRING}|-?\\d+)`;
const ARRAY = `\\[\\s*(?:${ITEM}(?:\\s*,\\s*${ITEM})*\\s*,?\\s*)?\\]`;
const VALUE = `(?:${STRING}|true|false|-?\\d+|${ARRAY})`;
const PAIR = new RegExp(`^(${KEY})\\s*=\\s*(${VALUE})\\s*(?:#.*)?$`);

function name(raw) {
  const key = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  if (FORBIDDEN.has(key)) throw new Error('config.toml uses a reserved key name.');
  return key;
}
function value(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith('[')) return (raw.match(new RegExp(ITEM, 'g')) ?? []).map(value);
  return Number(raw);
}
export function parseToml(text) {
  const root = Object.create(null);
  const explicit = new Set();
  let table = root;
  text.split(/\r?\n/).forEach((line, index) => {
    const fail = () => { throw new Error(`config.toml line ${index + 1} is not supported by the hosted-auth check (strict parser).`); };
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const header = trimmed.match(HEADER);
    if (header) {
      const parts = header[1].match(new RegExp(SEGMENT, 'g')).map(name);
      if (explicit.has(parts.join('\0'))) fail();
      explicit.add(parts.join('\0'));
      table = root;
      for (const part of parts) {
        if (table[part] === undefined) table[part] = Object.create(null);
        else if (typeof table[part] !== 'object' || Array.isArray(table[part])) fail();
        table = table[part];
      }
      return;
    }
    const pair = trimmed.match(PAIR);
    if (!pair) fail();
    const key = name(pair[1]);
    if (key in table) fail();
    table[key] = value(pair[2]);
  });
  return root;
}

function badUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol !== 'https:' || /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|.+\.local)$/i.test(url.hostname);
  } catch { return true; }
}
// Returns a list of problems for the committed (hosted-targeted) default; never includes values from the file.
export function checkHostedAuthConfig(text) {
  let config;
  try { config = parseToml(text); } catch (error) { return [error.message]; }
  const problems = [];
  const auth = config.auth ?? {};
  const testOtp = auth.sms?.test_otp;
  if (testOtp && Object.keys(testOtp).length) problems.push('[auth.sms.test_otp] has entries; fixed OTPs must not be in the committed config.');
  const captcha = auth.captcha;
  if (!captcha || captcha.enabled !== true) problems.push('[auth.captcha] enabled must be true in the committed config.');
  else {
    if (captcha.secret !== 'env(SUPABASE_AUTH_CAPTCHA_SECRET)') problems.push('[auth.captcha] secret must be env(SUPABASE_AUTH_CAPTCHA_SECRET).');
    if (!captcha.provider) problems.push('[auth.captcha] provider is missing.');
  }
  for (const [hookName, hook] of Object.entries(auth.hook ?? {})) {
    if (typeof hook !== 'object' || hook === null || Array.isArray(hook) || (hook.enabled !== undefined && hook.enabled !== false)) {
      problems.push(`[auth.hook.${hookName}] must be disabled (enabled = false) in the committed config; local hooks live in supabase/config.local.toml.`);
    }
  }
  if (auth.site_url !== undefined && badUrl(auth.site_url)) problems.push('[auth] site_url must be an https URL on a non-local host.');
  if (auth.additional_redirect_urls !== undefined) {
    const urls = auth.additional_redirect_urls;
    if (!Array.isArray(urls) || urls.some(badUrl)) problems.push('[auth] additional_redirect_urls must be https URLs on non-local hosts.');
  }
  return problems;
}

const GENERATED_HEADER = '# GENERATED, LOCAL ONLY. Do not link or push this workdir.\n';
// Merge overlay tables over the base file, keeping the base text. Existing keys are replaced in place, new keys are
// added at the end of their table, new tables are appended.
export function applyOverlay(baseText, overlayText) {
  const overlay = parseToml(overlayText);
  const lines = baseText.split(/\r?\n/);
  const flat = [];
  (function walk(node, path) {
    const scalars = Object.entries(node).filter(([, v]) => typeof v !== 'object' || Array.isArray(v));
    if (scalars.length) flat.push([path.join('.'), scalars]);
    for (const [k, v] of Object.entries(node)) if (typeof v === 'object' && !Array.isArray(v)) walk(v, [...path, k]);
  })(overlay, []);
  const keyLine = (k, v) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${typeof v === 'string' || Array.isArray(v) ? JSON.stringify(v) : String(v)}`;
  for (const [table, entries] of flat) {
    let start = lines.findIndex((l) => l.trim() === `[${table}]`);
    if (start < 0) { while (lines.length && lines.at(-1).trim() === '') lines.pop(); lines.push('', `[${table}]`); start = lines.length - 1; }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    for (const [k, v] of entries) {
      const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*"?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*=`).test(l));
      if (at >= 0) lines[at] = keyLine(k, v);
      else { let insert = end; while (insert > start + 1 && lines[insert - 1].trim() === '') insert -= 1; lines.splice(insert, 0, keyLine(k, v)); end += 1; }
    }
  }
  return GENERATED_HEADER + lines.join('\n').replace(/\n+$/, '\n');
}

// Writes <out>/supabase/config.toml (base + overlay) and links migrations, functions, seed.sql and .env.local (a
// dangling link is fine) beside it, so `supabase start --workdir <out>` runs the project with local fixtures.
export function generateLocalWorkdir({ root = REPO_ROOT, out = join(root, '.supabase-local') } = {}) {
  const source = join(root, 'supabase');
  const target = join(out, 'supabase');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'config.toml'), applyOverlay(readFileSync(join(source, 'config.toml'), 'utf8'), readFileSync(join(source, 'config.local.toml'), 'utf8')));
  for (const entry of ['migrations', 'functions', 'seed.sql', '.env.local']) symlinkSync(join(source, entry), join(target, entry));
  return target;
}

let invoked = false;
try { invoked = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* not the entry point */ }
if (invoked) {
  const [mode, file] = process.argv.slice(2);
  if (mode === 'check') {
    const problems = checkHostedAuthConfig(readFileSync(file ? resolve(file) : join(REPO_ROOT, 'supabase/config.toml'), 'utf8'));
    if (problems.length) { console.error(`Unsafe committed supabase/config.toml:\n- ${problems.join('\n- ')}`); process.exit(1); }
    console.log('Committed supabase/config.toml is production-safe (no test OTPs, CAPTCHA on, hooks disabled).');
  } else if (mode === 'local') {
    console.log(`Generated ${generateLocalWorkdir()}\nRun: supabase start --workdir .supabase-local`);
  } else { console.error('Usage: hosted-auth-config.mjs check [file] | local'); process.exit(2); }
}
