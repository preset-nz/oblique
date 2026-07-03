import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layer-boundary rule 4b (design/architecture.md §Layer boundaries): "nobody
 * but src/cook/ calls the sidecar client's cook". Import-based checks alone
 * can't express this — SidecarClient.request is a general-purpose method,
 * legitimately imported outside src/cook/ for `ping`/`list_ops`/status. So
 * this is a grep-based reachability check (the story's allowed fallback):
 * no source file outside src/cook/ may issue a `cook` op request.
 */

const SRC_DIR = join(__dirname);
const COOK_OP_PATTERN = /op\s*:\s*['"]cook['"]/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.[jt]sx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('layer boundary: only src/cook/ issues cook requests', () => {
  it('no file outside src/cook/ contains a cook op request', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const relative = file.slice(SRC_DIR.length + 1);
      if (relative.startsWith(`cook${sep}`) || relative === 'cook.ts') {
        continue;
      }
      const content = readFileSync(file, 'utf-8');
      if (COOK_OP_PATTERN.test(content)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});
