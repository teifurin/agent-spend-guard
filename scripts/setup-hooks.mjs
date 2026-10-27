// Points git at the versioned hooks in .githooks. Runs on `npm install` through the "prepare" script.
// Does nothing outside a git checkout (for example a downloaded zip) or when git is unavailable.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // not a git repository, or git is missing: nothing to set up
}
