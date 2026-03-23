const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function ensureExecutable(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    const executableMask = 0o111;
    if ((stat.mode & executableMask) === executableMask) return;
    fs.chmodSync(filePath, stat.mode | executableMask);
  } catch (error) {
    console.warn(`[builder] Could not chmod ${filePath}: ${error.message}`);
  }
}
for (const candidate of [
  path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder'),
  path.join(__dirname, '..', 'node_modules', 'app-builder-bin', 'linux', 'x64', 'app-builder'),
  path.join(__dirname, '..', 'node_modules', 'app-builder-bin', 'mac', 'app-builder_amd64'),
  path.join(__dirname, '..', 'node_modules', 'app-builder-bin', 'mac', 'app-builder_arm64'),
]) ensureExecutable(candidate);
const cliPath = require.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit', cwd: path.resolve(__dirname, '..'), env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 0);
