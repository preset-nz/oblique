import { MarqueeBox, type MarqueeBoxProps } from './MarqueeBox';

/**
 * Rectangle marquee overlay (features/05-selection/marquees.md). 8 resize
 * handles, drag-to-move once drawn — `MarqueeBox` owns the shared geometry
 * and drag logic with `EllipseMarquee`; this file only fixes `kind: 'rect'`.
 */
export function RectMarquee(props: Omit<MarqueeBoxProps, 'kind'>) {
  return <MarqueeBox kind="rect" {...props} />;
}
