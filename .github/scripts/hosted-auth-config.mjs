import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Minimal TOML reader for supabase/config.toml: [dotted.tables], `key = value` lines, comments. Values stay as
// parsed scalars (string, boolean, number) or the raw text for arrays; nothing else in this file needs more.
function unquote(key) { return /^"(.*)"$/.test(key) ? key.slice(1, -1) : key; }
function scalar(raw) {
  const text = raw.trim();
  const str = text.match(/^"((?:[^"\\]|\\.)*)"/);
  if (str) return str[1];
  const bare = text.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return bare;
}
export function parseToml(text) {
  const root = {};
  let table = root;
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const header = trimmed.match(/^\[([^\[\]]+)\]\s*(#.*)?$/);
    if (header) {
      table = root;
      for (const part of header[1].split('.').map((p) => unquote(p.trim()))) table = table[part] ??= {};
      return;
    }
    const pair = trimmed.match(/^("[^"]+"|[A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) throw new Error(`config.toml line ${index + 1} is not understood by the hosted-auth check.`);
    table[unquote(pair[1])] = scalar(pair[2]);
  });
  return root;
}

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[^.]+\.local|kong)$/i;
// Returns a list of problems; never includes values from the file (no secrets in logs).
export function checkHostedAuthConfig(text) {
  const problems = [];
  let config;
  try { config = parseToml(text); } catch (error) { return [error.message]; }
  const auth = config.auth ?? {};
  const testOtp = auth.sms?.test_otp;
  if (testOtp && Object.keys(testOtp).length) problems.push('[auth.sms.test_otp] has entries; fixed OTPs must not be in the committed config.');
  const captcha = auth.captcha;
  if (!captcha || captcha.enabled !== true) problems.push('[auth.captcha] enabled must be true in the committed config.');
  else {
    if (typeof captcha.secret !== 'string' || !/^env\(SUPABASE_AUTH_CAPTCHA_SECRET\)$/.test(captcha.secret)) problems.push('[auth.captcha] secret must be env(SUPABASE_AUTH_CAPTCHA_SECRET).');
    if (!captcha.provider) problems.push('[auth.captcha] provider is missing.');
  }
  const hook = auth.hook?.send_sms;
  if (hook?.uri !== undefined) {
    let host = null;
    try { const url = new URL(String(hook.uri)); host = url.protocol === 'https:' ? url.hostname : null; } catch { /* invalid */ }
    if (host === null) problems.push('[auth.hook.send_sms] uri must be an https URL.');
    else if (LOCAL_HOST.test(host)) problems.push('[auth.hook.send_sms] uri points at a local address.');
  }
  return problems;
}

// Merge overlay tables over the base file, keeping the base text (comments, order). Existing keys are replaced in
// place, new keys are added at the end of their table, new tables are appended.
export function applyOverlay(baseText, overlayText) {
  const overlay = parseToml(overlayText);
  const lines = baseText.split(/\r?\n/);
  const flat = [];
  (function walk(node, path) {
    const scalars = Object.entries(node).filter(([, v]) => typeof v !== 'object');
    if (scalars.length) flat.push([path.join('.'), scalars]);
    for (const [k, v] of Object.entries(node)) if (typeof v === 'object') walk(v, [...path, k]);
  })(overlay, []);
  const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  const keyLine = (k, v) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${fmt(v)}`;
  for (const [table, entries] of flat) {
    let start = lines.findIndex((l) => l.trim() === `[${table}]`);
    if (start < 0) { lines.push('', `[${table}]`); start = lines.length - 1; }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    for (const [k, v] of entries) {
      const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*"?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*=`).test(l));
      if (at >= 0) lines[at] = keyLine(k, v);
      else { let insert = end; while (insert > start + 1 && lines[insert - 1].trim() === '') insert -= 1; lines.splice(insert, 0, keyLine(k, v)); end += 1; }
    }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

// Writes <out>/supabase/config.toml (base + overlay) and links migrations, functions and seed.sql beside it, so
// `supabase start --workdir <out>` runs the same project with local fixtures. Never touches a remote project.
export function generateLocalWorkdir({ root = process.cwd(), out = join(root, '.supabase-local') } = {}) {
  const source = join(root, 'supabase');
  const target = join(out, 'supabase');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'config.toml'), applyOverlay(readFileSync(join(source, 'config.toml'), 'utf8'), readFileSync(join(source, 'config.local.toml'), 'utf8')));
  for (const name of ['migrations', 'functions', 'seed.sql', '.env.local']) if (existsSync(join(source, name))) symlinkSync(join(source, name), join(target, name));
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const root = process.cwd();
  if (mode === 'check') {
    const problems = checkHostedAuthConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8'));
    if (problems.length) { console.error(`Unsafe committed supabase/config.toml:\n- ${problems.join('\n- ')}`); process.exit(1); }
    console.log('Committed supabase/config.toml is production-safe (no test OTPs, CAPTCHA on, non-local hook).');
  } else if (mode === 'local') {
    console.log(`Generated ${generateLocalWorkdir({ root })}\nRun: supabase start --workdir .supabase-local`);
  } else { console.error('Usage: hosted-auth-config.mjs check|local'); process.exit(2); }
}
