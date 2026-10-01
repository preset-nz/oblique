import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }));

import * as history from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import { isTextNode, type Scene, type TextNode } from '@/scene/types';
import { applyFontReplacements } from './replaceFont';
import { BLACKLETTER_BOLD, INSTALLED } from './testFixtures';
import { fontRefOf } from './types';

const emptyScene = (): Scene => ({
  id: 's',
  nodes: [],
  cameras: [],
  defaultCameraId: null,
  resolution: 'working',
  documentSize: [800, 400],
});

const fontsOf = () =>
  useSceneStore
    .getState()
    .scene.nodes.filter(isTextNode)
    .map((n) => n.font.postscriptName);

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  history.clear();
});

describe('applyFontReplacements', () => {
  it('replaces across 3 nodes as ONE undo step, skipping the locked node', async () => {
    const add = () =>
      useSceneStore
        .getState()
        .addTextNode({ content: 'a', font: BLACKLETTER_BOLD, position: { x: 0, y: 0 } });
    const ids = [add(), add(), add(), add()];
    const other = useSceneStore
      .getState()
      .addTextNode({ content: 'b', font: fontRefOf(INSTALLED[0]), position: { x: 0, y: 0 } });
    history.clear();
    // lock one of the four (state flip only; no bake machinery needed here)
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === ids[3] ? { ...n, state: 'locked' as const } : n)),
      },
    }));
    history.clear();

    const to = fontRefOf(INSTALLED[3]);
    const result = applyFontReplacements([{ fromPostscript: BLACKLETTER_BOLD.postscriptName, to }]);
    expect(result).toEqual({ replaced: 3, skipped: 1 });

    const byId = (id: string) =>
      (useSceneStore.getState().scene.nodes.find((n) => n.id === id) as TextNode).font
        .postscriptName;
    expect([ids[0], ids[1], ids[2]].map(byId)).toEqual(Array(3).fill(to.postscriptName));
    expect(byId(ids[3])).toBe(BLACKLETTER_BOLD.postscriptName); // locked: untouched
    expect(byId(other)).toBe('HelveticaNeue'); // different font: untouched

    // One Cmd+Z restores everything.
    expect(history.canUndo()).toBe(true);
    await history.undo();
    expect(fontsOf().filter((p) => p === BLACKLETTER_BOLD.postscriptName)).toHaveLength(4);
    expect(history.canUndo()).toBe(false);
  });

  it('does nothing (and pushes no history) when no row actually changes', () => {
    useSceneStore
      .getState()
      .addTextNode({ content: 'a', font: BLACKLETTER_BOLD, position: { x: 0, y: 0 } });
    history.clear();
    expect(
      applyFontReplacements([
        { fromPostscript: BLACKLETTER_BOLD.postscriptName, to: BLACKLETTER_BOLD },
      ]),
    ).toEqual({ replaced: 0, skipped: 0 });
    expect(history.canUndo()).toBe(false);
  });
});
