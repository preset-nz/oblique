import { describe, expect, it } from 'vitest';
import { hasUrlScheme, isRelativeSourcePath, resolveSourcePath } from './resolvePath';

describe('resolveSourcePath', () => {
  it('uses an absolute path as is, with or without a project', () => {
    expect(resolveSourcePath('/a/b.png', null)).toEqual({ kind: 'file', absPath: '/a/b.png' });
    expect(resolveSourcePath('/a/../b.png', '/x/p.oblique')).toEqual({
      kind: 'file',
      absPath: '/a/../b.png', // absolute paths are never normalised either
    });
  });

  it('resolves a relative path against the folder of the saved project', () => {
    expect(resolveSourcePath('plates/a.png', '/x/proj.oblique')).toEqual({
      kind: 'file',
      absPath: '/x/plates/a.png',
    });
    expect(resolveSourcePath('a.png', '/proj.oblique')).toEqual({
      kind: 'file',
      absPath: '/a.png',
    });
  });

  it('allows .. segments and collapses . segments', () => {
    expect(resolveSourcePath('../plates/a.png', '/x/y/proj.oblique')).toEqual({
      kind: 'file',
      absPath: '/x/plates/a.png',
    });
    expect(resolveSourcePath('./a/./b.png', '/x/proj.oblique')).toEqual({
      kind: 'file',
      absPath: '/x/a/b.png',
    });
  });

  it('clamps .. at the filesystem root', () => {
    expect(resolveSourcePath('../../../a.png', '/x/proj.oblique')).toEqual({
      kind: 'file',
      absPath: '/a.png',
    });
  });

  it('flags a relative path in an unsaved project', () => {
    expect(resolveSourcePath('plates/a.png', null)).toEqual({
      kind: 'unresolvable',
      reason: 'relative-unsaved',
    });
  });

  it('rejects strata:// and any other scheme://', () => {
    for (const stored of ['strata://asset/1', 'https://example.com/a.png', 'file:///a.png']) {
      expect(resolveSourcePath(stored, '/x/p.oblique')).toEqual({
        kind: 'unresolvable',
        reason: 'unsupported-scheme',
      });
    }
  });

  it('does not treat a relative path containing a colon as a scheme', () => {
    expect(resolveSourcePath('a:b/c.png', '/x/p.oblique')).toEqual({
      kind: 'file',
      absPath: '/x/a:b/c.png',
    });
  });

  it('classifies stored strings', () => {
    expect(hasUrlScheme('strata://x')).toBe(true);
    expect(hasUrlScheme('/a')).toBe(false);
    expect(isRelativeSourcePath('a.png')).toBe(true);
    expect(isRelativeSourcePath('/a.png')).toBe(false);
    expect(isRelativeSourcePath('strata://a')).toBe(false);
  });
});
