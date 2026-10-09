import { mkdtempSync, rmSync } from 'node:fs';

const directories = new Set<string>();

process.once('exit', () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove test directory ${directory}:`, error);
      process.exitCode ||= 1;
    }
  }
});

// Exit cleanup also covers failed module setup and legacy process.exit() calls.
// Test-specific teardown still closes databases and restores mocks first.
export function createTempDir(prefix: string): string {
  const directory = mkdtempSync(prefix);
  directories.add(directory);
  return directory;
}
