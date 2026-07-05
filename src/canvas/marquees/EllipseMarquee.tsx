import { MarqueeBox, type MarqueeBoxProps } from './MarqueeBox';

/**
 * Ellipse marquee overlay (features/05-selection/marquees.md). Same bounding
 * box, handles and drag logic as `RectMarquee` (`MarqueeBox`), inscribed as
 * an ellipse rather than drawn as a rectangle.
 */
export function EllipseMarquee(props: Omit<MarqueeBoxProps, 'kind'>) {
  return <MarqueeBox kind="ellipse" {...props} />;
}
