import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@preset.nz/ux-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@preset.nz/ux-kit')>()),
  notify: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn() }));

import { notify } from '@preset.nz/ux-kit';
import { homeDir } from '@tauri-apps/api/path';
import {
  copyPath,
  folderOf,
  homeDirOnce,
  resetHomeDirCache,
  SavedToastPath,
  shortenHome,
} from './SavedToastPath';

beforeEach(() => {
  vi.clearAllMocks();
  resetHomeDirCache();
});

describe('shortenHome', () => {
  it('shows the home directory as ~, with or without its trailing slash', () => {
    expect(shortenHome('/Users/georg/Documents/creatures', '/Users/georg/')).toBe(
      '~/Documents/creatures',
    );
    expect(shortenHome('/Users/georg/Documents', '/Users/georg')).toBe('~/Documents');
    expect(shortenHome('/Users/georg', '/Users/georg/')).toBe('~');
  });

  it('leaves a folder outside home, a lookalike sibling, or an unknown home alone', () => {
    expect(shortenHome('/Volumes/art', '/Users/georg/')).toBe('/Volumes/art');
    expect(shortenHome('/Users/georgia/art', '/Users/georg/')).toBe('/Users/georgia/art');
    expect(shortenHome('/Users/georg/art', null)).toBe('/Users/georg/art');
  });
});

describe('folderOf', () => {
  it('drops the filename', () => {
    expect(folderOf('/a/b/c.oblique')).toBe('/a/b');
    expect(folderOf('/c.oblique')).toBe('/');
  });
});

describe('homeDirOnce', () => {
  it('reads the home directory once', async () => {
    vi.mocked(homeDir).mockResolvedValue('/Users/georg/');
    expect(await homeDirOnce()).toBe('/Users/georg/');
    expect(await homeDirOnce()).toBe('/Users/georg/');
    expect(homeDir).toHaveBeenCalledTimes(1);
  });

  it('is null when the lookup fails, so the full folder shows', async () => {
    vi.mocked(homeDir).mockRejectedValue(new Error('no home'));
    expect(await homeDirOnce()).toBeNull();
  });
});

describe('SavedToastPath', () => {
  it('shows the shortened folder and a labelled copy button', () => {
    const html = renderToStaticMarkup(
      <SavedToastPath
        path="/Users/georg/Documents/creatures/creature.oblique"
        home="/Users/georg/"
      />,
    );
    expect(html).toContain('~/Documents/creatures');
    expect(html).not.toContain('creature.oblique');
    expect(html).toContain('aria-label="Copy path"');
  });

  it('shows the full folder when home is unknown', () => {
    const html = renderToStaticMarkup(
      <SavedToastPath path="/Users/georg/art/a.oblique" home={null} />,
    );
    expect(html).toContain('/Users/georg/art');
    expect(html).not.toContain('~');
  });
});

describe('copyPath', () => {
  it('writes the full absolute path, not the shortened folder', async () => {
    const writeText = vi.fn(async () => {});
    const path = '/Users/georg/Documents/creatures/creature.oblique';

    expect(await copyPath(path, { writeText, notify })).toBe(true);

    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the browser clipboard by default', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      expect(await copyPath('/a/b.oblique')).toBe(true);
      expect(writeText).toHaveBeenCalledWith('/a/b.oblique');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refused write is an error toast, 'Couldn't copy the path'", async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });

    expect(await copyPath('/a/b.oblique', { writeText, notify })).toBe(false);

    expect(notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'error',
      message: "Couldn't copy the path",
    });
  });
});
