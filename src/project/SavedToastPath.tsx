import { Icons, notify, Tooltip, TooltipContent, TooltipTrigger } from '@preset.nz/ux-kit';
import { homeDir } from '@tauri-apps/api/path';
import { useEffect, useRef, useState } from 'react';

/** How long the copy button shows its check before turning back into the copy icon. */
const CHECK_MS = 1500;

let homeOnce: Promise<string | null> | undefined;

/**
 * The home directory, read once (Tauri's `homeDir()`); null if that fails, in which case the
 * folder line shows the full path.
 */
export function homeDirOnce(): Promise<string | null> {
  homeOnce ??= homeDir().then(
    (home) => home,
    () => null,
  );
  return homeOnce;
}

/** Forget the cached home directory (tests). */
export function resetHomeDirCache(): void {
  homeOnce = undefined;
}

/** `/a/b/c.oblique` -> `/a/b`; a bare name has no folder. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return '';
  return slash === 0 ? '/' : path.slice(0, slash);
}

/** The folder with the home directory shortened to `~`; unchanged when it isn't under home. */
export function shortenHome(folder: string, home: string | null): string {
  if (!home) return folder;
  const base = home.length > 1 ? home.replace(/\/+$/, '') : home;
  if (folder === base) return '~';
  return folder.startsWith(`${base}/`) ? `~${folder.slice(base.length)}` : folder;
}

export interface CopyDeps {
  writeText: (text: string) => Promise<void>;
  notify: typeof notify;
}

const browserCopyDeps: CopyDeps = {
  writeText: (text) => navigator.clipboard.writeText(text),
  notify: (opts) => notify(opts),
};

/** Put the full path on the clipboard. A refusal is an error toast; resolves whether it worked. */
export async function copyPath(path: string, deps: CopyDeps = browserCopyDeps): Promise<boolean> {
  try {
    await deps.writeText(path);
    return true;
  } catch {
    deps.notify({ kind: 'error', message: "Couldn't copy the path" });
    return false;
  }
}

/**
 * The description of the saved toast: the folder (home shown as `~`) and a copy button for the
 * file's full absolute path. `home` comes from `homeDirOnce()`, read before the toast is shown.
 */
export function SavedToastPath({ path, home }: { path: string; home: string | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const folder = shortenHome(folderOf(path), home);

  const onClick = async () => {
    if (!(await copyPath(path))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CHECK_MS);
  };

  return (
    <span className="flex items-center gap-1">
      <span className="min-w-0 flex-1 truncate" title={folder}>
        {folder}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Copy path"
              onClick={onClick}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            />
          }
        >
          {copied ? <Icons.CheckIcon size={12} /> : <Icons.CopyIcon size={12} />}
        </TooltipTrigger>
        <TooltipContent>Copy path</TooltipContent>
      </Tooltip>
    </span>
  );
}
