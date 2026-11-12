import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
  cwd, encoding: 'utf8', windowsHide: true
});
if (upstream.status !== 0) {
  console.log('This local project has no Git upstream yet. Keeping the local source and checking setup.');
} else {
  const result = spawnSync('git', ['pull', '--ff-only'], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
