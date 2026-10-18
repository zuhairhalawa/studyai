#!/usr/bin/env node
// Dependency-free secret scanner for the working tree AND the whole git history.
//
//   node scripts/scan-secrets.mjs               scan working tree + all history, exit 1 on any finding
//   node scripts/scan-secrets.mjs --no-history  working tree only (fast pre-commit check)
//   node scripts/scan-secrets.mjs --self-test   run the detectors against in-memory samples
//
// What it checks
//   1. Working tree: every tracked and untracked-but-not-ignored file (`git ls-files -co --exclude-standard`).
//      Binary files and files over 2 MB are skipped (and counted in the report).
//   2. History: every added line of every commit reachable from any ref (`git log --all -p`).
//   3. Forbidden file names (.dev.vars, .env, *.pem, *.key, *.p12, *.pptx outside tests/fixtures/,
//      *.studyai.zip) in the working tree index and anywhere in history.
//
// Output never contains a full secret: values are shown as their first 4 characters plus an ellipsis.
// Exit codes: 0 clean, 1 findings (or self-test failure), 2 the scan itself could not run.
//
// Allowlist: `.secretscanignore` at the repo root, one entry per line, `path-glob` or `path-glob:PATTERN_ID`.
// Every entry must carry a comment explaining why it is a false positive.
//
// This file must not contain a literal match for its own detectors; the self-test samples are built by
// concatenation at run time.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 5 * 1024 * 1024;
const MIN_SCANNABLE_LINE = 20; // the shortest detector (AWS key id) needs 20 characters
const FORBIDDEN_ID = 'forbidden-file';
const GIT = ['-c', 'core.quotepath=false'];

// ---------------------------------------------------------------------------------------------------------------
// Detectors. Specific signatures come first so that a value is reported once, under its most specific name.
// `value` is the capture group holding the secret (0 = whole match). `placeholders` and `skipExampleFiles` apply
// only to the heuristic detectors, never to fixed-format signatures.
// ---------------------------------------------------------------------------------------------------------------
const KEYWORDS =
  'api[_-]?key|secret|token|passwd|password|owner[_-]?key(?:[_-]?hash)?|session[_-]?secret|private[_-]?key|access[_-]?key|client[_-]?secret';

/** @type {{id:string, re:RegExp, value:number, heuristic?:boolean, desc:string}[]} */
const DETECTORS = [
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/dg, value: 0, desc: 'Google API key' },
  { id: 'anthropic-key', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/dg, value: 0, desc: 'Anthropic API key' },
  { id: 'openai-key', re: /(?<![A-Za-z0-9])sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/dg, value: 0, desc: 'OpenAI-style API key' },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/dg, value: 0, desc: 'GitHub token' },
  {
    id: 'cloudflare-token',
    re: /(?<![A-Za-z0-9])(?:cloudflare|cf_)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{37,40})(?![A-Za-z0-9_-])/dgi,
    value: 1,
    heuristic: true,
    desc: 'Cloudflare API token / key assigned to a CLOUDFLARE* or CF_* variable',
  },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg, value: 0, desc: 'AWS access key id' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/dg, value: 0, desc: 'Slack token' },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}/dg, value: 0, desc: 'Stripe live key' },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/dg, value: 0, desc: 'npm access token' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/dg, value: 0, desc: 'Private key block' },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/dg, value: 0, desc: 'JSON Web Token' },
  {
    id: 'generic-secret',
    re: new RegExp(`(?:${KEYWORDS})["']?\\s*[:=]\\s*["']?([A-Za-z0-9+/_\\-]{20,})`, 'dgi'),
    value: 1,
    heuristic: true,
    desc: 'Secret-like value assigned to a key/secret/token/password variable',
  },
];
const DETECTOR_IDS = new Set([...DETECTORS.map((d) => d.id), FORBIDDEN_ID]);

const PLACEHOLDER_RE = /replace[-_]?me|placeholder|change[-_]?me|your[-_]|xxx|example|redacted/i;

/** Obvious non-secrets: empty, a documented placeholder, or one repeated character. */
function isPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER_RE.test(value)) return true;
  return new Set(value).size <= 2;
}

function redact(value) {
  return `${value.slice(0, 4)}…`;
}

const isExampleFile = (path) => /\.example$/i.test(path);

/** Scan one line of text. Returns findings that carry only a redacted value and a fingerprint, never the secret. */
function scanLine(line, path = '') {
  if (line.length < MIN_SCANNABLE_LINE) return [];
  const found = [];
  const spans = [];
  for (const det of DETECTORS) {
    for (const m of line.matchAll(det.re)) {
      const value = m[det.value];
      if (!value) continue;
      if (det.heuristic && (isPlaceholder(value) || isExampleFile(path))) continue;
      const [start, end] = m.indices[det.value];
      if (spans.some(([s, e]) => start < e && s < end)) continue; // already reported by a more specific detector
      spans.push([start, end]);
      found.push({ id: det.id, shown: redact(value), fp: createHash('sha256').update(value).digest('hex').slice(0, 16) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Forbidden file names
// ---------------------------------------------------------------------------------------------------------------
/** Returns why a path must never be committed, or null. `.example` files are templates and always allowed. */
function forbiddenReason(path) {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.example')) return null;
  if (base === '.dev.vars' || base.startsWith('.dev.vars.')) return 'Worker secrets file (.dev.vars)';
  if (base === '.env' || base.startsWith('.env.')) return 'environment file (.env)';
  if (/\.(pem|key|p12)$/.test(base)) return 'private key / certificate file';
  if (base.endsWith('.studyai.zip')) return 'study export archive (*.studyai.zip)';
  if (base.endsWith('.pptx') && !norm.startsWith('tests/fixtures/')) return 'lecture deck (*.pptx outside tests/fixtures/)';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Allowlist (.secretscanignore)
// ---------------------------------------------------------------------------------------------------------------
function globToRegExp(glob) {
  let g = glob.replace(/\\/g, '/');
  const rooted = g.startsWith('/');
  if (rooted) g = g.slice(1);
  if (g.endsWith('/')) g += '**';
  const anchored = rooted || g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}

function parseAllowlist(text) {
  const entries = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    let glob = line;
    let id = null;
    const colon = line.lastIndexOf(':');
    if (colon > 0) {
      glob = line.slice(0, colon).trim();
      id = line.slice(colon + 1).trim();
      if (!DETECTOR_IDS.has(id)) {
        errors.push(`.secretscanignore:${i + 1}: unknown pattern id "${id}"`);
        return;
      }
    }
    entries.push({ raw: line, id, re: globToRegExp(glob), hits: 0, lineNo: i + 1 });
  });
  return { entries, errors };
}

function makeAllowlist(entries) {
  return (path, id) => {
    const p = path.replace(/\\/g, '/');
    for (const e of entries) {
      if ((e.id === null || e.id === id) && e.re.test(p)) {
        e.hits++;
        return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// History: incremental parser for `git log -p --format=commit:%H` output. Only added lines reach `onAdded`.
// ---------------------------------------------------------------------------------------------------------------
const COMMIT_LINE = /^commit:[0-9a-f]{40,64}$/;

class DiffScanner {
  /** @param {(commit:string, path:string, lineNo:number, text:string) => void} onAdded */
  constructor(onAdded) {
    this.onAdded = onAdded;
    this.commit = '';
    this.path = null;
    this.state = 'none'; // none | header | hunk
    this.newLine = 0;
    this.commits = 0;
    this.addedLines = 0;
  }

  feed(line) {
    if (COMMIT_LINE.test(line)) {
      this.commit = line.slice(7);
      this.commits++;
      this.state = 'none';
      this.path = null;
      return;
    }
    if (line.startsWith('diff --git ')) {
      this.state = 'header';
      this.path = null;
      return;
    }
    if (this.state === 'header') {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).replace(/\t.*$/, '');
        this.path = p === '/dev/null' ? null : p.replace(/^"?b\//, '').replace(/"$/, '');
      } else if (line.startsWith('@@')) {
        this.hunk(line);
      }
      return;
    }
    if (this.state !== 'hunk') return;
    if (line.startsWith('@@')) return this.hunk(line);
    const c = line[0];
    if (c === '+') {
      this.addedLines++;
      if (this.path !== null) this.onAdded(this.commit, this.path, this.newLine, line.slice(1));
      this.newLine++;
    } else if (c === ' ') this.newLine++;
  }

  hunk(line) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    this.newLine = m ? Number(m[1]) : 0;
    this.state = 'hunk';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------------------------------------------
/** Runs git and delivers stdout as complete lines (or NUL-separated records) without buffering the whole output. */
function streamGit(args, onLine, sep = '\n') {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...GIT, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d;
    });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let start = 0;
      let i;
      while ((i = buf.indexOf(sep, start)) >= 0) {
        let line = buf.slice(start, i);
        if (sep === '\n' && line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line);
        start = i + 1;
      }
      buf = buf.slice(start);
      if (buf.length > MAX_LINE_CHARS) {
        onLine(buf);
        buf = '';
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) onLine(sep === '\n' && buf.endsWith('\r') ? buf.slice(0, -1) : buf);
      if (code !== 0) reject(new Error(`git ${args.slice(0, 2).join(' ')} exited with ${code}: ${stderr.trim().slice(0, 300)}`));
      else resolvePromise();
    });
  });
}

async function gitLines(args, sep = '\n') {
  const out = [];
  await streamGit(args, (l) => out.push(l), sep);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------------------------------------------
async function scanWorkingTree(allowed, report) {
  const files = (await gitLines(['ls-files', '-co', '--exclude-standard', '-z'], '\0')).filter(Boolean);
  const stats = { files: files.length, scanned: 0, binary: 0, large: [], missing: 0 };
  for (const rel of files) {
    const reason = forbiddenReason(rel);
    if (reason) report.forbidden.push({ where: 'tree', path: rel, reason });
    const abs = join(ROOT, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      stats.missing++; // tracked but deleted in the working tree
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) {
      stats.large.push(rel);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      stats.binary++;
      continue;
    }
    stats.scanned++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      for (const f of scanLine(lines[n], rel)) {
        if (allowed(rel, f.id)) {
          report.suppressed++;
          continue;
        }
        report.findings.push({ where: 'tree', path: rel, line: n + 1, ...f });
      }
    }
  }
  return stats;
}

async function scanHistory(allowed, report) {
  const stats = { commits: 0, addedLines: 0, shallow: false, paths: 0 };
  const shallow = await gitLines(['rev-parse', '--is-shallow-repository']);
  stats.shallow = shallow[0] === 'true';

  // Added lines. A secret that persists across commits is reported once, at the commit that introduced it.
  const seen = new Map();
  const scanner = new DiffScanner((commit, path, line, text) => {
    for (const f of scanLine(text, path)) {
      const key = `${f.id}|${path}|${f.fp}`;
      const prev = seen.get(key);
      if (prev) {
        if (prev.commit !== commit) prev.extra.add(commit);
        prev.commit = commit; // git log is newest-first, so the last one seen is the oldest
        prev.line = line;
        continue;
      }
      seen.set(key, { where: 'history', commit, path, line, ...f, extra: new Set() });
    }
  });
  const logArgs = ['log', '--all', '-p', '--no-color', '--no-textconv', '--no-ext-diff', '--diff-merges=first-parent', '--format=commit:%H'];
  await streamGit(logArgs, (l) => scanner.feed(l));
  stats.commits = scanner.commits;
  stats.addedLines = scanner.addedLines;
  for (const f of seen.values()) {
    if (allowed(f.path, f.id)) report.suppressed++;
    else report.findings.push(f);
  }

  // Forbidden file names anywhere in history (including files that were later deleted).
  const first = new Map();
  let commit = '';
  await streamGit(['log', '--all', '--name-only', '--no-color', '--diff-merges=first-parent', '--format=commit:%H'], (l) => {
    if (COMMIT_LINE.test(l)) commit = l.slice(7);
    else if (l) first.set(l, commit); // newest-first, so the last assignment is the earliest commit
  });
  stats.paths = first.size;
  for (const [path, c] of first) {
    const reason = forbiddenReason(path);
    if (reason) report.forbidden.push({ where: 'history', path, commit: c, reason });
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------
const short = (c) => c.slice(0, 10);

function printReport(report, treeStats, histStats, entries) {
  const out = [];
  out.push('Secret scan');
  out.push(
    `  working tree : ${treeStats.scanned} files scanned of ${treeStats.files} listed` +
      ` (${treeStats.binary} binary skipped, ${treeStats.large.length} over 2 MB skipped, ${treeStats.missing} deleted)`,
  );
  for (const f of treeStats.large) out.push(`                 skipped (too large): ${f}`);
  if (histStats) {
    out.push(`  history      : ${histStats.commits} commits, ${histStats.addedLines} added lines, ${histStats.paths} distinct paths`);
    if (histStats.shallow) out.push('  WARNING      : shallow clone, history is incomplete. Fetch full history (git fetch --unshallow) for a real check.');
  } else out.push('  history      : skipped (--no-history)');
  for (const e of entries) out.push(`  allowlist    : ${e.raw} (suppressed ${e.hits})${e.hits === 0 ? '  <- unused, remove it' : ''}`);
  out.push('');

  const tree = report.findings.filter((f) => f.where === 'tree');
  const hist = report.findings.filter((f) => f.where === 'history');
  if (tree.length) {
    out.push(`Secret-like values in the working tree (${tree.length})`);
    for (const f of tree) out.push(`  ${f.path}:${f.line}  [${f.id}]  ${f.shown}`);
    out.push('');
  }
  if (hist.length) {
    out.push(`Secret-like values in git history (${hist.length})`);
    for (const f of hist) {
      const more = f.extra.size ? `, also in ${f.extra.size} later commit(s)` : '';
      out.push(`  ${short(f.commit)}:${f.path}:${f.line}  [${f.id}]  ${f.shown}  (introduced here${more})`);
    }
    out.push('');
  }
  if (report.forbidden.length) {
    out.push(`Forbidden file names (${report.forbidden.length})`);
    for (const f of report.forbidden) {
      out.push(f.where === 'tree' ? `  working tree : ${f.path}  (${f.reason})` : `  history ${short(f.commit)}:${f.path}  (${f.reason})`);
    }
    out.push('');
  }

  const total = report.findings.length + report.forbidden.length;
  const byId = {};
  for (const f of report.findings) byId[f.id] = (byId[f.id] ?? 0) + 1;
  if (report.forbidden.length) byId[FORBIDDEN_ID] = report.forbidden.length;
  out.push(
    total === 0
      ? `OK: no findings (${report.suppressed} suppressed by .secretscanignore).`
      : `FAIL: ${total} finding(s): ${Object.entries(byId).map(([k, v]) => `${k}=${v}`).join(', ')} (${report.suppressed} suppressed).`,
  );
  if (total) out.push('If a finding is a real secret: rotate it first, then clean the history. See SECURITY.md.');
  console.log(out.join('\n'));
  return total;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test: detectors run against in-memory samples built by concatenation.
// ---------------------------------------------------------------------------------------------------------------
const fill = (n, alphabet = 'k9Zq3Wm7Rt') => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

function selfTest() {
  const failures = [];
  let checks = 0;
  const check = (name, ok) => {
    checks++;
    if (!ok) failures.push(name);
  };
  const ids = (line, path = 'src/a.ts') => scanLine(line, path).map((f) => f.id);

  /** [detector id, sample line that MUST fire it] */
  const positives = [
    ['google-api-key', 'const k = "' + 'AI' + 'za' + fill(35) + '";'],
    ['anthropic-key', 'ANTHROPIC=' + 'sk-' + 'ant-' + 'api03-' + fill(40)],
    ['openai-key', 'OPENAI=' + 'sk-' + fill(40, 'aB3dE5')],
    ['openai-key', 'OPENAI=' + 'sk-' + 'proj-' + fill(40, 'aB3-dE5_')],
    ['github-token', 'tok ' + 'gh' + 'p_' + fill(36)],
    ['github-token', 'tok ' + 'github' + '_pat_' + fill(40)],
    ['cloudflare-token', 'CLOUDFLARE_' + 'API_TOKEN=' + fill(40)],
    ['cloudflare-token', 'CF_' + 'API_KEY: "' + fill(37) + '"'],
    ['aws-access-key', 'id = ' + 'AK' + 'IA' + fill(16, 'Q7ZM2')],
    ['slack-token', 'x ' + 'xo' + 'xb-' + fill(30, '1234567')],
    ['stripe-live-key', 'x ' + 'sk' + '_live_' + fill(30)],
    ['npm-token', 'x ' + 'npm' + '_' + fill(36)],
    ['private-key', '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----'],
    ['private-key', '-----BEGIN ' + 'PRIVATE' + ' KEY-----'],
    ['private-key', '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----'],
    ['jwt', 'Bearer ' + 'ey' + 'J' + fill(14) + '.ey' + 'J' + fill(14) + '.' + fill(14)],
    ['generic-secret', 'session_' + 'secret = "' + fill(32) + '"'],
    ['generic-secret', 'OWNER_KEY' + '_HASH=' + fill(44, 'aB3dE5+/')],
    ['generic-secret', '{"api' + 'Key": "' + fill(24) + '"}'],
    ['generic-secret', 'pass' + 'word: ' + fill(24)],
    ['generic-secret', 'url?to' + 'ken=' + fill(30)],
  ];
  for (const [id, line] of positives) {
    const got = ids(line);
    check(`detector ${id} fires on its sample`, got.includes(id));
    check(`detector ${id} sample reported once`, got.length === 1);
  }
  for (const d of DETECTORS) check(`detector ${d.id} has a positive sample`, positives.some(([id]) => id === d.id));

  const shortG = 'AI' + 'za' + fill(34);
  const shortO = 'sk-' + fill(31, 'aB3dE5');
  const negatives = [
    'GEMINI_API_KEY=',
    'GEMINI_API_KEY=replace-me',
    'api_key: "your-api-key-goes-here-please"',
    'SESSION_SECRET=changeme-changeme-changeme',
    'token = "placeholder_placeholder_value"',
    'password: ' + 'x'.repeat(10) + 'x'.repeat(14),
    'secret: "' + 'a'.repeat(30) + '"',
    'OWNER_KEY_HASH=example-hash-example-hash-example',
    'const secret = process.env.SESSION_SECRET_VALUE_FROM_ENV;',
    'CLOUDFLARE_API_TOKEN=replace-me-replace-me-replace-me-replace',
    'the key ' + shortG + ' is one character short',
    'the key ' + shortO + ' is one character short',
    'a task-' + fill(40, 'aB3dE5') + ' css class is not an sk- key',
    '-----BEGIN CERTIFICATE-----',
    'export function isPlaceholder(value: string): boolean { return value === ""; }',
  ];
  for (const line of negatives) check(`placeholder / non-secret does not fire: ${line.slice(0, 40)}`, ids(line).length === 0);

  const heuristicInExample = 'session_' + 'secret = "' + fill(32) + '"';
  check('heuristic detectors skip *.example files', ids(heuristicInExample, '.dev.vars.example').length === 0);
  check('fixed-format signatures still fire in *.example files', ids(positives[0][1], '.env.example').includes('google-api-key'));

  const sample = 'AI' + 'za' + fill(35);
  const [f] = scanLine('k=' + sample, 'a.ts');
  check('redaction keeps only 4 chars + ellipsis', f?.shown === 'AIza…');
  check('finding object never holds the raw secret', f !== undefined && !JSON.stringify(f).includes(sample.slice(5)));

  // forbidden names
  const bad = ['.dev.vars', 'worker/.dev.vars', '.dev.vars.production', '.env', 'a/.env.local', 'k/server.pem', 'x.KEY', 'cert.p12', 'deck.pptx', 'tests/other/deck.pptx', 'a/b.studyai.zip'];
  const good = ['.dev.vars.example', '.env.example', 'tests/fixtures/deck.pptx', 'tests/fixtures/sub/deck.pptx', 'docs/env.md', 'src/keyboard.ts', 'a.zip', 'monkey.ts', 'README.md'];
  for (const p of bad) check(`forbidden: ${p}`, forbiddenReason(p) !== null);
  for (const p of good) check(`allowed: ${p}`, forbiddenReason(p) === null);

  // allowlist parsing and globbing
  const al = parseAllowlist('# c\n\ntests/**/*.ts:google-api-key  # why\n*.md\nbogus:not-a-real-id\n');
  check('allowlist reports unknown ids', al.errors.length === 1 && al.entries.length === 2);
  const allowed = makeAllowlist(al.entries);
  check('allowlist glob + id matches', allowed('tests/a/b.ts', 'google-api-key'));
  check('allowlist id restricts', !allowed('tests/a/b.ts', 'jwt'));
  check('allowlist ** needs the prefix', !allowed('src/tests/b.ts', 'google-api-key'));
  check('allowlist bare glob matches at any depth', allowed('docs/x/y.md', 'jwt'));
  check('allowlist does not match other files', !allowed('src/a.ts', 'jwt'));

  // history parser: only added lines, correct path and line numbers, commit boundaries
  const c1 = 'commit:' + 'a'.repeat(40);
  const c2 = 'commit:' + 'b'.repeat(40);
  const seen = [];
  const sc = new DiffScanner((commit, path, line, text) => seen.push([commit.slice(0, 1), path, line, text]));
  [
    c1, '', 'diff --git a/src/one.ts b/src/one.ts', 'index 111..222 100644', '--- a/src/one.ts', '+++ b/src/one.ts',
    '@@ -1,3 +10,4 @@ fn', ' ctx', '-removed secret line', '+added line one', '+++ looks like a header but is content', ' ctx2', '',
    c2, '', 'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-old',
    'diff --git a/pic.png b/pic.png', 'Binary files /dev/null and b/pic.png differ',
    'diff --git a/with space.txt b/with space.txt', '--- /dev/null', '+++ b/with space.txt\t', '@@ -0,0 +1,2 @@', '+first', '+second',
  ].forEach((l) => sc.feed(l));
  check('diff parser: commits counted', sc.commits === 2);
  check('diff parser: only added lines', seen.length === 4);
  check('diff parser: line numbers', seen[0]?.[2] === 11 && seen[1]?.[2] === 12);
  check('diff parser: content starting with +++ is content', seen[1]?.[3] === '++ looks like a header but is content');
  check('diff parser: paths with spaces, commit attribution', seen[2]?.[1] === 'with space.txt' && seen[2]?.[0] === 'b' && seen[3]?.[3] === 'second');

  if (failures.length) {
    console.error(`self-test FAILED: ${failures.length} of ${checks} checks`);
    for (const f of failures) console.error(`  - ${f}`);
    return false;
  }
  console.log(`self-test OK: ${checks} checks, ${DETECTORS.length} detectors`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set(['--self-test', '--no-history', '--help', '-h']);
  for (const a of args) {
    if (!known.has(a)) {
      console.error(`unknown option: ${a}`);
      return 2;
    }
  }
  if (args.has('--help') || args.has('-h')) {
    console.log('usage: node scripts/scan-secrets.mjs [--no-history | --self-test]');
    return 0;
  }
  if (args.has('--self-test')) return selfTest() ? 0 : 1;

  const ignorePath = join(ROOT, '.secretscanignore');
  const { entries, errors } = existsSync(ignorePath) ? parseAllowlist(readFileSync(ignorePath, 'utf8')) : { entries: [], errors: [] };
  if (errors.length) {
    for (const e of errors) console.error(e);
    return 2;
  }
  const allowed = makeAllowlist(entries);
  const report = { findings: [], forbidden: [], suppressed: 0 };
  const treeStats = await scanWorkingTree(allowed, report);
  const histStats = args.has('--no-history') ? null : await scanHistory(allowed, report);
  // forbidden-file entries in the allowlist also apply
  report.forbidden = report.forbidden.filter((f) => {
    if (allowed(f.path, FORBIDDEN_ID)) {
      report.suppressed++;
      return false;
    }
    return true;
  });
  return printReport(report, treeStats, histStats, entries) === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`scan-secrets: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
