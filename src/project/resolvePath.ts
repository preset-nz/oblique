/**
 * Pixel-source path resolver (image-source.md): the ONE place a stored
 * `sourcePath` becomes a file to read. Pure; no fs, no Tauri.
 *
 * The stored string is kept exactly as typed — never normalised, expanded or
 * rewritten (decision 2). The scheme decides how it resolves:
 * - leading `/`         -> absolute, used as is;
 * - `scheme://…`        -> unresolvable (`strata://` is reserved for a later story);
 * - anything else       -> relative to the folder holding the saved project file.
 */

export type UnresolvableReason = 'relative-unsaved' | 'unsupported-scheme';

export type Resolved =
  | { kind: 'file'; absPath: string }
  | { kind: 'unresolvable'; reason: UnresolvableReason };

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True for `strata://…` and every other `scheme://…` string. */
export function hasUrlScheme(stored: string): boolean {
  return SCHEME_RE.test(stored);
}

/** True when `stored` is a plain relative path (no leading `/`, no scheme). */
export function isRelativeSourcePath(stored: string): boolean {
  return !stored.startsWith('/') && !hasUrlScheme(stored);
}

/** Parent folder of `path`; the root stays `/`. */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return '/';
  return path.slice(0, cut);
}

/**
 * Join an absolute folder and a relative path, collapsing `.` and `..`.
 * `..` above the root clamps at the root (`/a/../../b` -> `/b`).
 */
function joinNormalised(base: string, relative: string): string {
  const out: string[] = [];
  for (const part of `${base}/${relative}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export function resolveSourcePath(stored: string, projectPath: string | null): Resolved {
  if (stored.startsWith('/')) return { kind: 'file', absPath: stored };
  if (hasUrlScheme(stored)) return { kind: 'unresolvable', reason: 'unsupported-scheme' };
  if (projectPath === null) return { kind: 'unresolvable', reason: 'relative-unsaved' };
  return { kind: 'file', absPath: joinNormalised(dirname(projectPath), stored) };
}
