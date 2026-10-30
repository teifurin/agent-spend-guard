// Points git at the versioned hooks in .githooks. Runs on `npm install` through the "prepare" script.
// It changes one setting of this repository only (core.hooksPath), never the user's global git configuration.
// Does nothing outside a git checkout (for example a downloaded zip) or when git is unavailable.
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  // Git runs a hook only when the file is executable. The mode is committed (100755); this repairs a checkout that lost it.
  if (process.platform !== 'win32') chmodSync('.githooks/pre-commit', 0o755);
} catch {
  // not a git repository, or git is missing: nothing to set up
}
