import { useId } from 'react';
import { type MarqueeParams, useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import {
  SELECTION_FILL_COLOUR,
  SELECTION_FILL_OPACITY,
  useSelectionFillStore,
} from './selectionFillState';

export interface SelectionFillProps {
  /** Path data in document space; every sub-path of a selection goes in one `d` so `evenodd` can cut holes. */
  d: string;
  fillRule?: 'nonzero' | 'evenodd';
  /** The marquee toolbar's Feather, Expand and Invert; absent means the raw shape. */
  params?: MarqueeParams;
  /** Document size in px: invert fills it and the tint is clipped to it while a param is active. */
  documentSize?: [number, number];
}

/**
 * What every call site hands `SelectionFill`: the marquee toolbar's params (the same ones
 * "Mask from selection" consumes, whichever tool drew the selection) and the document size.
 * Call it at the top of the component, before any early return.
 */
export function useSelectionFillInputs(): Pick<SelectionFillProps, 'params' | 'documentSize'> {
  const params = useMarqueeStateStore((s) => s.params);
  const documentSize = useSceneStore((s) => s.scene.documentSize);
  return { params, documentSize };
}

/** Same threshold as `rasterizeVectorMask`, which skips a feather that rounds to under 1px. */
const MIN_FEATHER_PX = 0.5;

/**
 * Standard deviation of the preview blur. `boxBlurMask`'s three box passes come out at sigma ~
 * radius (measured 0.96-0.99 x radius for 4-30px), so the filter takes `featherPx` as is.
 */
export function featherSigma(featherPx: number): number {
  return featherPx >= MIN_FEATHER_PX ? featherPx : 0;
}

/** True when a param changes the mask, so the tint cannot just be the raw shape. */
export function paramsChangeFill(params: MarqueeParams | undefined): boolean {
  return !!params && (featherSigma(params.featherPx) > 0 || params.expand !== 0 || params.invert);
}

/**
 * The translucent fill under a selection outline (selection-fill-overlay.md). Another `<path>` in
 * the overlay's own SVG, so the shared `viewTransform` on the parent `<g>` places it; there is no
 * canvas paint. Render it before the outline so the outline stays on top. `pointer-events: none`
 * so it never catches a click. Renders nothing while View -> Show Selection Fill is off.
 *
 * With Feather, Expand or Invert set (selection-fill-params.md) it previews the mask "Mask from
 * selection" will make, in `rasterizeVectorMask`'s order: fill, expand stroke (round join and
 * cap, `2 x |expand|` wide; a negative expand cuts it out through an SVG mask), feather
 * (`feGaussianBlur`), invert (the document rectangle minus the blurred shape), then a clip to the
 * document. The layers are drawn opaque and the 18% applies once to the group, so a stroke
 * overlapping the fill does not double up. An approximation, not a second rasteriser.
 */
export function SelectionFill({
  d,
  fillRule = 'nonzero',
  params,
  documentSize,
}: SelectionFillProps) {
  const enabled = useSelectionFillStore((s) => s.enabled);
  const id = `sf${useId().replace(/:/g, '')}`;
  if (!enabled) return null;

  const [docW, docH] = documentSize ?? [0, 0];
  if (!params || !paramsChangeFill(params) || !(docW > 0) || !(docH > 0)) {
    return (
      <path
        data-selection-fill=""
        d={d}
        fill={SELECTION_FILL_COLOUR}
        fillOpacity={SELECTION_FILL_OPACITY}
        fillRule={fillRule}
        stroke="none"
        style={{ pointerEvents: 'none' }}
      />
    );
  }

  const sigma = featherSigma(params.featherPx);
  const { expand, invert } = params;
  const clipId = `${id}clip`;
  const blurId = `${id}blur`;
  const cutId = `${id}cut`;
  const invertId = `${id}inv`;

  // The blur and the cut mask work on the document plus the blur's reach; the clip trims the rest.
  const pad = 4 * sigma + 1;
  const region = { x: -pad, y: -pad, width: docW + 2 * pad, height: docH + 2 * pad };

  /** fill + expand stroke + feather, in `colour`. The mask code draws it black to subtract it. */
  const shape = (colour: string) => {
    const body = (
      <g mask={expand < 0 ? `url(#${cutId})` : undefined}>
        <path d={d} fill={colour} fillRule={fillRule} stroke="none" />
        {expand > 0 && (
          <path
            d={d}
            fill="none"
            stroke={colour}
            strokeWidth={2 * expand}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </g>
    );
    return sigma > 0 ? <g filter={`url(#${blurId})`}>{body}</g> : body;
  };

  return (
    <g
      data-selection-fill=""
      opacity={SELECTION_FILL_OPACITY}
      clipPath={`url(#${clipId})`}
      style={{ pointerEvents: 'none' }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={docW} height={docH} />
        </clipPath>
        {sigma > 0 && (
          <filter id={blurId} filterUnits="userSpaceOnUse" {...region}>
            <feGaussianBlur stdDeviation={sigma} />
          </filter>
        )}
        {expand < 0 && (
          <mask id={cutId} maskUnits="userSpaceOnUse" {...region}>
            <rect {...region} fill="#fff" />
            <path
              d={d}
              fill="none"
              stroke="#000"
              strokeWidth={2 * -expand}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </mask>
        )}
        {invert && (
          <mask id={invertId} maskUnits="userSpaceOnUse" {...region}>
            <rect {...region} fill="#fff" />
            {shape('#000')}
          </mask>
        )}
      </defs>
      {invert ? (
        <rect
          x={0}
          y={0}
          width={docW}
          height={docH}
          fill={SELECTION_FILL_COLOUR}
          mask={`url(#${invertId})`}
        />
      ) : (
        shape(SELECTION_FILL_COLOUR)
      )}
    </g>
  );
}
