import type { PathCommand } from '@/scene/vectorRasterize';

/**
 * `PathCommand[]` (`vectorRasterize.ts::pathCommandsFor`) -> an SVG `<path>`
 * `d` attribute. Shared by `PenTool.tsx` (in-progress preview) and
 * `PathEditor.tsx` (committed-path overlay + segment hit target) so both
 * draw from the exact same command stream the rasteriser fills — the SVG
 * preview can never drift from what will actually composite.
 */
function commandToPathD(cmd: PathCommand): string {
  switch (cmd.op) {
    case 'moveTo':
      return `M${cmd.to.x},${cmd.to.y}`;
    case 'lineTo':
      return `L${cmd.to.x},${cmd.to.y}`;
    case 'bezierCurveTo':
      return `C${cmd.c1.x},${cmd.c1.y} ${cmd.c2.x},${cmd.c2.y} ${cmd.to.x},${cmd.to.y}`;
    case 'closePath':
      return 'Z';
  }
}

export function commandsToPathD(commands: PathCommand[]): string {
  return commands.map(commandToPathD).join(' ');
}
