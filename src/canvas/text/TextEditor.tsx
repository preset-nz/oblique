import { useEffect, useRef } from 'react';
import { useSceneStore } from '@/scene/store';
import { getGeometry, useTextGeometryStore } from '@/scene/textGeometryCache';
import { isTextNode, type TextNode } from '@/scene/types';
import { docToScreen, useViewTransformStore } from '../viewTransform';
import { commitActiveTextEdit, useTextEditStore } from './textEditState';
import { editorAnchorDoc } from './textFrame';

/**
 * The floating overlay editor (text-tool-and-inspector.md): a plain HTML
 * `<textarea>` over the canvas, not a WYSIWYG imitation of the type — the live
 * raster shows through underneath and updates on every keystroke. Mounted by
 * `Viewport.tsx` in the container div (HTML, so a sibling of the SVG overlay).
 *
 * Every `input` writes `setTextProps(id, { content })`. The edit's history
 * transaction (opened by `beginNewTextAt`/`beginReEdit`) makes the whole
 * session one undo step. All the ways out go through `commitActiveTextEdit`.
 */

const MIN_ROWS = 1;

function TextEditorInner({ node }: { node: TextNode }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const view = useViewTransformStore((s) => s.view);
  const documentSize = useSceneStore((s) => s.scene.documentSize);
  useTextGeometryStore((s) => s.version); // re-render when this node's geometry lands

  // Focus through a ref (biome's noAutofocus). Once on mount, plus a frame
  // later: the pointerdown that opened the editor can still move focus after
  // mount, and the caret must end up in the textarea.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const raf = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  // A primary pointerdown anywhere outside the textarea commits. Capture phase
  // on window, so it runs before the canvas handler: a click that places or
  // re-opens another edit then finds nothing open, instead of committing the
  // edit it just started.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      commitActiveTextEdit();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const anchor = docToScreen(view, editorAnchorDoc(node, getGeometry(node), documentSize));
  const lines = node.content.split('\n');
  const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);

  return (
    <textarea
      ref={ref}
      aria-label="Edit text"
      value={node.content}
      rows={Math.max(MIN_ROWS, lines.length)}
      spellCheck={false}
      onChange={(e) => useSceneStore.getState().setTextProps(node.id, { content: e.target.value })}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return; // IME owns Enter/Escape mid-composition
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          commitActiveTextEdit();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          commitActiveTextEdit();
        }
        // Plain Enter inserts a newline (point text, manual line breaks only).
      }}
      className="absolute z-10 resize-none overflow-hidden rounded border border-neutral-600 bg-neutral-950/80 px-1.5 py-1 font-sans text-sm text-neutral-100 outline-none focus:border-sky-400"
      style={{
        left: anchor.x,
        top: anchor.y,
        minWidth: '12rem',
        width: `${Math.max(widest, 12) + 2}ch`,
      }}
    />
  );
}

export function TextEditor() {
  const editing = useTextEditStore((s) => s.editing);
  const node = useSceneStore((s) =>
    editing ? s.scene.nodes.find((n) => n.id === editing.nodeId) : undefined,
  );
  if (!editing || !node || !isTextNode(node)) return null;
  return <TextEditorInner key={editing.nodeId} node={node} />;
}
