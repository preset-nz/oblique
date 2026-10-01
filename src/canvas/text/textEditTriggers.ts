import { commitActiveTextEdit } from '@/scene/textEditState';
import { useToolStateStore } from '../toolState';

/**
 * Side-effect module (imported by `Viewport.tsx`): a tool change commits the open
 * text edit. The rest of the commit triggers live next to the edit store in
 * `scene/textEditState.ts`; this one is here because it needs `toolState`, and
 * `scene/` can't import `canvas/`.
 */
useToolStateStore.subscribe((state, prev) => {
  if (state.tool !== prev.tool) commitActiveTextEdit();
});
