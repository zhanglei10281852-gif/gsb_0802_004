import { readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function findTestFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const r of roots) {
    walk(resolve(r), files);
  }
  return files;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
}
