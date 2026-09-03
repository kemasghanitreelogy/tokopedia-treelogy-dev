import { spawn } from 'node:child_process';

/** Open a URL in the default browser without going through a shell. */
export function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
