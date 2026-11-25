import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIST_DIR = path.resolve('dist');
const WORKTREE_DIR = path.join(os.tmpdir(), `shurale-gh-pages-${Date.now()}`);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function getOutput(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('dist/index.html not found. Run "npm run build" first.');
  }

  const remoteUrl = getOutput('git', ['remote', 'get-url', 'origin']);
  const userName = getOutput('git', ['config', 'user.name']);
  const userEmail = getOutput('git', ['config', 'user.email']);

  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  try {
    fs.cpSync(DIST_DIR, WORKTREE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKTREE_DIR, '.nojekyll'), '');

    run('git', ['init', '-b', 'gh-pages'], { cwd: WORKTREE_DIR });
    run('git', ['config', 'user.name', userName], { cwd: WORKTREE_DIR });
    run('git', ['config', 'user.email', userEmail], { cwd: WORKTREE_DIR });
    run('git', ['add', '-A'], { cwd: WORKTREE_DIR });
    run('git', ['commit', '-m', 'Deploy WebAR dist to gh-pages'], { cwd: WORKTREE_DIR });
    run('git', ['remote', 'add', 'origin', remoteUrl], { cwd: WORKTREE_DIR });
    run('git', ['push', '--force', 'origin', 'gh-pages'], { cwd: WORKTREE_DIR });
    console.log('Successfully pushed dist/ to origin/gh-pages');
  } finally {
    fs.rmSync(WORKTREE_DIR, { recursive: true, force: true });
  }
}

main();
