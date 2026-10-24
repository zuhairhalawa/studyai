// Rejects commits that carry AI attribution: an AI tool named as co-author or assistant in a trailer, a "Generated with ..." footer,
// or an AI as author or committer (GitHub would list it as a contributor). Human co-authors are fine.
// Usage:
//   node scripts/check-attribution.mjs               the commits of the current GitHub event (pull request: base..head, push: before..after),
//                                                    or the last 20 commits when there is no event or its commits are not in this clone
//   node scripts/check-attribution.mjs --range A..B  an explicit git revision range
//   node scripts/check-attribution.mjs --all         every commit on every ref (an audit; fails on an old history that has attribution)
//   node scripts/check-attribution.mjs --self-test   checks the rules against throw-away repositories
// Exit status: 0 clean, 1 attribution found, 2 usage or git error.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AI_NAMES = '(claude|anthropic|copilot|chatgpt|openai|codex|gemini)';
const TRAILER = new RegExp(`^\\s*(co-authored-by|co-developed-by|assisted-by|generated-by|signed-off-by)\\s*:.*${AI_NAMES}`, 'i');
const FOOTER = /^[^\p{L}\p{N}]*generated (with|by) .*(claude|anthropic)/iu;
const IDENTITY = /(claude|anthropic)/i;
const ZERO = /^0+$/;

/** What is wrong with one commit message; the subject line (the first line) is never judged. */
export function messageProblems(message) {
  return message
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => TRAILER.test(line) || FOOTER.test(line))
    .map((line) => `message line: ${line.trim()}`);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const known = (cwd, sha) => {
  try {
    git(cwd, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

/** The revisions to examine, from the arguments, then the GitHub event, then the last 20 commits. */
export function chooseRevisions(cwd, args, env = process.env) {
  if (args.all) return { label: 'every commit on every ref', revs: ['--all'] };
  if (args.range) return { label: args.range, revs: [args.range] };
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    const ev = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pair = ev.pull_request ? [ev.pull_request.base?.sha, ev.pull_request.head?.sha] : [ev.before, ev.after];
    const [from, to] = pair;
    if (from && to && !ZERO.test(from) && known(cwd, from) && known(cwd, to)) return { label: `${from.slice(0, 7)}..${to.slice(0, 7)}`, revs: [`${from}..${to}`] };
  }
  return { label: 'the last 20 commits', revs: ['-n', '20', 'HEAD'] };
}

/** Every problem found in the chosen commits: [{ sha, subject, problem }]. */
export function findProblems(cwd, revs) {
  const rec = '\x1e';
  const sep = '\x1f';
  const out = git(cwd, 'log', `--format=%H${sep}%an${sep}%ae${sep}%cn${sep}%ce${sep}%s${sep}%B${rec}`, ...revs);
  const found = [];
  for (const record of out.split(rec)) {
    const body = record.replace(/^\n/, '');
    if (!body.trim()) continue;
    const [sha, an, ae, cn, ce, subject, message] = body.split(sep);
    for (const problem of messageProblems(message)) found.push({ sha, subject, problem });
    for (const [role, name, email] of [['author', an, ae], ['committer', cn, ce]]) {
      if (IDENTITY.test(name) || IDENTITY.test(email)) found.push({ sha, subject, problem: `${role} is an AI identity: ${name} <${email}>` });
    }
  }
  return found;
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'check-attribution-'));
  const fail = [];
  const expect = (name, ok) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) fail.push(name);
  };
  try {
    // hooks and signing are switched off so the test can create the commits it needs to catch
    const base = ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test Author', '-c', 'user.email=test@example.org'];
    const run = (...args) => execFileSync('git', [...base, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = (subject, body = '', env = {}) => {
      writeFileSync(join(dir, 'f.txt'), `${subject}${Math.random()}\n`);
      run('add', '-A');
      execFileSync('git', [...base, 'commit', '-q', '--no-verify', '-m', subject, ...(body ? ['-m', body] : [])], { cwd: dir, env: { ...process.env, ...env }, stdio: 'pipe' });
    };
    const head = () => run('rev-parse', 'HEAD').trim();
    run('init', '-q', '-b', 'main');

    expect('a plain message is clean', messageProblems('fix: x\n\nbody').length === 0);
    expect('a Claude co-author trailer is found', messageProblems('x\n\nCo-Authored-By: Claude <noreply@anthropic.com>').length === 1);
    expect('a model-named trailer is found', messageProblems('x\n\nco-authored-by: Claude Opus 4.1 <noreply@anthropic.com>').length === 1);
    expect('the Claude account address is found', messageProblems('x\n\nCo-authored-by: C <81847+claude@users.noreply.github.com>').length === 1);
    expect('Copilot and an assistant trailer are found', messageProblems('x\n\nCo-authored-by: Copilot <c@github.com>\nAssisted-by: ChatGPT').length === 2);
    expect('a generated-with footer is found', messageProblems('x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)').length === 1);
    expect('a human co-author is allowed', messageProblems('x\n\nCo-authored-by: Sam Rivera <sam@example.org>').length === 0);
    expect('a subject or prose that only mentions Claude is allowed', messageProblems('docs: describe the Claude Code skill\n\nClaude Code writes the pack; output is generated with a script.').length === 0);
    expect('a subject that looks like a footer is not judged', messageProblems('Generated with Claude Code').length === 0);

    commit('first');
    const first = head();
    commit('second', 'Co-authored-by: Sam Rivera <sam@example.org>');
    expect('a clean history passes', findProblems(dir, ['--all']).length === 0);
    commit('third', 'Co-Authored-By: Claude <noreply@anthropic.com>');
    const third = head();
    expect('--all finds the trailer', findProblems(dir, ['--all']).length === 1);
    expect('a range before the bad commit passes', findProblems(dir, [`${first}..HEAD~1`]).length === 0);
    expect('a range with the bad commit fails', findProblems(dir, [`${first}..HEAD`]).length === 1);
    commit('fourth', '', { GIT_AUTHOR_NAME: 'Claude', GIT_AUTHOR_EMAIL: 'noreply@anthropic.com' });
    expect('an AI author is found', findProblems(dir, [`${third}..HEAD`]).some((p) => p.problem.startsWith('author is an AI identity')));

    const event = (payload) => {
      const file = join(dir, 'event.json');
      writeFileSync(file, JSON.stringify(payload));
      return { GITHUB_EVENT_PATH: file };
    };
    const tip = head();
    expect('a pull_request event uses base..head', chooseRevisions(dir, {}, event({ pull_request: { base: { sha: third }, head: { sha: tip } } })).revs[0] === `${third}..${tip}`);
    expect('a push event uses before..after', chooseRevisions(dir, {}, event({ before: first, after: tip })).revs[0] === `${first}..${tip}`);
    expect('a new-branch push (all-zero before) falls back to the last 20 commits', chooseRevisions(dir, {}, event({ before: '0'.repeat(40), after: tip })).revs.includes('HEAD'));
    expect('a before commit that no longer exists (force push) falls back', chooseRevisions(dir, {}, event({ before: 'a'.repeat(40), after: tip })).revs.includes('HEAD'));
    expect('no event falls back to the last 20 commits', chooseRevisions(dir, {}, {}).revs.includes('HEAD'));
    expect('--range wins over the event', chooseRevisions(dir, { range: 'x..y' }, event({ before: first, after: tip })).revs[0] === 'x..y');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(fail.length ? `self-test FAILED: ${fail.length}` : 'self-test OK');
  return fail.length === 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const args = { all: argv.includes('--all') };
  const r = argv.indexOf('--range');
  if (r >= 0) args.range = argv[r + 1];
  if (r >= 0 && !args.range) {
    console.error('--range needs a git revision range, for example --range origin/main..HEAD');
    process.exit(2);
  }
  try {
    const { label, revs } = chooseRevisions(process.cwd(), args);
    const found = findProblems(process.cwd(), revs);
    console.log(`attribution check: ${label}`);
    for (const f of found) {
      console.error(`${f.sha.slice(0, 7)} ${f.subject}\n    ${f.problem}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=AI attribution in a commit::${f.sha.slice(0, 7)} ${f.subject}: ${f.problem}`);
    }
    if (found.length) {
      console.error(`FAILED: ${found.length} problem(s). Remove the trailer or footer (git commit --amend, or reword the commit) and push again. Human co-authors are fine.`);
      process.exit(1);
    }
    console.log('clean: no AI attribution found');
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
