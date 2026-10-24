// The sweep, with everything a reviewer needs to trust it, in one file to paste:
//
//   npx tsx scripts/sweep-report.ts [sweep arguments, e.g. --seeds 8]
//
// Finds the repository from where this script is (nothing to type, no path or project
// name to get wrong), checks it is on the expected branch with nothing uncommitted, and
// writes sweep-report.txt at the repository's root: the git state, `npm run check`, then
// the whole sweep, all verbatim. On the wrong branch, or with changes in the tree, it
// stops and says so in that same file, and changes nothing. The branch expected is
// claude/hopeful-einstein-mq251b, or SWEEP_BRANCH if set.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = process.env.SWEEP_BRANCH ?? 'claude/hopeful-einstein-mq251b';
const out = join(root, 'sweep-report.txt');
const lines: string[] = ['REPORT', `Written by scripts/sweep-report.ts in ${root}`, ''];

/** Runs a command at the repository's root; records it, its output and its exit code. */
function run(cmd: string, args: string[]): { code: number; text: string } {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  const code = r.status ?? 1;
  lines.push(`$ ${[cmd, ...args].join(' ')}`, text, `(exit ${code})`, '');
  return { code, text };
}

function finish(note: string): never {
  lines.push(note);
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${note}\nReport written to ${out}`);
  process.exit(0);
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).text.trim();
run('git', ['log', '-1', '--oneline']);
const status = run('git', ['status', '--short']).text.trim();
if (branch !== expected) finish(`STOPPED: on branch ${branch}, expected ${expected}. Nothing was run. Ask the reviewer which branch to use; do not switch branches on your own.`);
if (status !== '') finish('STOPPED: the working tree has uncommitted changes (above). Nothing was run. Report them to the reviewer; do not stash, reset or commit them.');
const check = run('npm', ['run', 'check']);
if (check.code !== 0) finish('STOPPED: npm run check failed (above). The sweep was not run.');
const sweep = run('npm', ['run', 'sweep', '--', ...process.argv.slice(2)]);
finish(sweep.code === 0 ? 'DONE: check passed and the sweep ran. Paste this whole file to the reviewer.' : 'FAILED: the sweep exited with an error (above). Paste this whole file to the reviewer.');
