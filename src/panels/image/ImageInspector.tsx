import { Icons } from '@preset.nz/ux-kit';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState } from 'react';
import { stackControlsDisabled } from '@/panels/stack/lockUi';
import { tauriImportDeps } from '@/project/import';
import { replaceImageDialog } from '@/project/io';
import { useProjectMetaStore } from '@/project/projectMeta';
import { resolveSourcePath } from '@/project/resolvePath';
import { replacePixelSource } from '@/scene/replaceSource';
import { type SourceMissingReason, useSourceMissingStore } from '@/scene/sources';
import type { PixelNode } from '@/scene/types';
import { useImageSectionStore } from './imageSectionCollapse';

const STRATA_REFUSAL = "Strata references aren't supported yet";

/** The line under an amber path field (image-source.md). */
function missingText(reason: SourceMissingReason): string {
  switch (reason) {
    case 'not-found':
      return 'File not found';
    case 'unreadable':
      return "Can't read this file";
    case 'relative-unsaved':
      return 'Relative path — save the project first';
    case 'unsupported-scheme':
      return STRATA_REFUSAL;
  }
}

/**
 * The Image section of the stack panel (image-source.md): the stored source
 * path as a plain editable field (Nuke's Read node, Houdini's File SOP), a
 * Browse… shortcut into the same replace flow, Reveal in Finder and the
 * source's pixel size. The path shows exactly as stored, never the resolved
 * one; the resolved path is the tooltip when it differs. A locked node renders
 * it inert, like the Text section.
 */
export function ImageInspector({ node }: { node: PixelNode }) {
  const locked = stackControlsDisabled(node);
  const collapsed = useImageSectionStore((s) => s.collapsed);
  const toggle = useImageSectionStore((s) => s.toggle);
  const missing = useSourceMissingStore((s) => Boolean(s.missing[node.id]));
  const reason = useSourceMissingStore((s) => s.reasons[node.id] ?? 'not-found');
  const projectPath = useProjectMetaStore((s) => s.path);

  const [draft, setDraft] = useState(node.sourcePath);
  const [refusal, setRefusal] = useState<string | null>(null);
  // True while a replace is in flight: Enter and the blur that follows it must
  // not replace twice. Never compared against the stored path — retyping the
  // unchanged path on a missing node is a retry (the file may exist now).
  const committingRef = useRef(false);
  // Escape reverts and blurs; the blur must not commit what was just discarded.
  const cancelledRef = useRef(false);

  // Undo/redo, another layer, or a Browse… pick changes the stored path under us.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only when the stored path or node changes
  useEffect(() => {
    setDraft(node.sourcePath);
    setRefusal(null);
  }, [node.id, node.sourcePath]);

  const resolved = resolveSourcePath(node.sourcePath, projectPath);
  const resolvedPath = resolved.kind === 'file' ? resolved.absPath : null;
  const tooltip = resolvedPath && resolvedPath !== node.sourcePath ? resolvedPath : undefined;

  async function commit(viaEnter: boolean) {
    if (committingRef.current) return;
    // Verbatim (decision 2): only an all-blank field counts as "nothing typed".
    // Enter on the unchanged path of a missing node retries; a bare blur doesn't.
    if (draft.trim() === '' || (draft === node.sourcePath && !(viaEnter && missing))) {
      setDraft(node.sourcePath);
      return;
    }
    committingRef.current = true;
    try {
      const result = await replacePixelSource(node.id, draft, tauriImportDeps);
      if (!result.ok) {
        setDraft(node.sourcePath);
        if (result.reason === 'unsupported-scheme') setRefusal(STRATA_REFUSAL);
      }
    } finally {
      committingRef.current = false;
    }
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand Image' : 'Collapse Image'}
        className="flex w-full items-center gap-1 px-3 pt-2 pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-neutral-200"
      >
        {collapsed ? <Icons.CaretRightIcon size={14} /> : <Icons.CaretDownIcon size={14} />}
        Image
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-2 px-3 pb-3 text-xs">
          <div className="flex flex-col gap-1">
            <label htmlFor={`image-path-${node.id}`} className="text-neutral-400">
              Path
            </label>
            <input
              id={`image-path-${node.id}`}
              value={draft}
              readOnly={locked}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              title={tooltip}
              onChange={(e) => {
                setDraft(e.target.value);
                setRefusal(null);
              }}
              onBlur={() => {
                if (cancelledRef.current) {
                  cancelledRef.current = false;
                  return;
                }
                void commit(false);
              }}
              onKeyDown={(e) => {
                // Enter/Escape belong to the field while it has focus — the
                // canvas Escape handler must not also clear the selection.
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commit(true);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(node.sourcePath);
                  setRefusal(null);
                  cancelledRef.current = true;
                  e.currentTarget.blur();
                }
              }}
              aria-invalid={missing || refusal !== null}
              className={`w-full min-w-0 rounded bg-neutral-900 px-2 py-1 font-mono text-xs outline-none ring-1 ${
                missing
                  ? 'text-amber-400 ring-amber-700/70'
                  : 'ring-neutral-700 focus:ring-neutral-500'
              }`}
            />
            {refusal ? (
              <span className="text-amber-400">{refusal}</span>
            ) : (
              missing && <span className="text-amber-400">{missingText(reason)}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={locked}
              onClick={() => void replaceImageDialog(node.id)}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              Browse…
            </button>
            <button
              type="button"
              disabled={missing || resolvedPath === null}
              onClick={() => {
                if (resolvedPath) void revealItemInDir(resolvedPath);
              }}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              Reveal in Finder
            </button>
          </div>
          <div className="flex items-baseline gap-2 text-neutral-400">
            <span>Size</span>
            <span className="text-neutral-200">
              {node.sourceSize[0]} × {node.sourceSize[1]} px
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
