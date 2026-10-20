import { ModelDeclined } from '@preset.nz/app-kit/models';
import { describe, expect, it, vi } from 'vitest';
import { chooseTool } from './ToolbarRail';

function makeDeps(ensure: (id: string, options?: { for?: string }) => Promise<void>) {
  return { ensure: vi.fn(ensure), setTool: vi.fn(), onError: vi.fn() };
}

describe('chooseTool (model-downloads.md)', () => {
  it('asks for MobileSAM before arming Smart Select, and arms it once ready', async () => {
    const order: string[] = [];
    const deps = makeDeps(async () => {
      order.push('ensure');
    });
    deps.setTool.mockImplementation(() => order.push('setTool'));

    await chooseTool('select-smart', deps);

    expect(deps.ensure).toHaveBeenCalledWith('mobile_sam', { for: 'Smart Select' });
    expect(deps.setTool).toHaveBeenCalledWith('select-smart');
    expect(order).toEqual(['ensure', 'setTool']);
  });

  it('does not arm the tool while the model is still being asked for', async () => {
    let finish: () => void = () => {};
    const deps = makeDeps(() => new Promise<void>((resolve) => (finish = resolve)));

    const chosen = chooseTool('select-smart', deps);
    await Promise.resolve();
    expect(deps.setTool).not.toHaveBeenCalled();

    finish();
    await chosen;
    expect(deps.setTool).toHaveBeenCalledWith('select-smart');
  });

  it('leaves the current tool in place on Not now, quietly', async () => {
    const deps = makeDeps(async () => {
      throw new ModelDeclined('mobile_sam');
    });

    await chooseTool('select-smart', deps);

    expect(deps.setTool).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('leaves the current tool in place on any other failure, and reports it', async () => {
    const boom = new Error('Unknown model mobile_sam');
    const deps = makeDeps(async () => {
      throw boom;
    });

    await chooseTool('select-smart', deps);

    expect(deps.setTool).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(boom);
  });

  it('asks for nothing for a tool without a model', async () => {
    const deps = makeDeps(async () => {});

    await chooseTool('select-colour', deps);
    await chooseTool('pen', deps);

    expect(deps.ensure).not.toHaveBeenCalled();
    expect(deps.setTool).toHaveBeenCalledWith('select-colour');
    expect(deps.setTool).toHaveBeenCalledWith('pen');
  });
});
