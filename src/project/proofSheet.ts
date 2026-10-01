/**
 * Proof-sheet chrome (features/12-print-toolkit/registration-marks-and-colour-bars.md).
 *
 * An export decoration, never scene content: the composited work area is
 * rendered exactly as a plain export would, then wrapped in a margin canvas
 * carrying registration marks and colour-bar patches. Split in two so the
 * geometry is testable without a canvas:
 *
 * - `proofLayout` — pure arithmetic: canvas size, work rect, marks, patches.
 * - `paintProof` — a thin painter over a 2D context. The work is drawn once at
 *   native size (`drawImage(src, x, y)`, no scaling) so its pixels are
 *   byte-identical to a plain export; the paper fills the margin only.
 *
 * Deterministic: no timestamps, no text.
 */

export type ProofPaper = 'white' | 'transparent';
export type ProofBarEdge = 'bottom' | 'right';
export type ProofBarSteps = 3 | 5 | 7;

export interface ProofOptions {
  /** Margin in px added on every side. */
  margin: number;
  paper: ProofPaper;
  marks: boolean;
  /** Extra registration marks at the four edge centres (corners are always marked when `marks`). */
  edgeMarks: boolean;
  bars: boolean;
  steps: ProofBarSteps;
  barEdge: ProofBarEdge;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A circle-and-crosshair registration mark, centred at (cx, cy). */
export interface Mark {
  cx: number;
  cy: number;
  /** Circle radius. */
  r: number;
  /** Half-length of each crosshair arm (the arms overshoot the circle). */
  arm: number;
  lineWidth: number;
}

export type Ink = 'c' | 'm' | 'y' | 'k' | 'grey';

/** One square colour-bar patch. */
export interface Patch extends Rect {
  ink: Ink;
  /** Ink coverage, 0..1. */
  tint: number;
  /** The screen approximation of the tint, as a CSS `rgb(...)` string. */
  colour: string;
}

export interface ProofLayout {
  width: number;
  height: number;
  work: Rect;
  marks: Mark[];
  patches: Patch[];
}

/** The subset of a 2D context `paintProof` needs — satisfied by the real thing, stubbed in tests. */
export type ProofContext = Pick<
  CanvasRenderingContext2D,
  | 'drawImage'
  | 'fillStyle'
  | 'fillRect'
  | 'strokeStyle'
  | 'lineWidth'
  | 'beginPath'
  | 'arc'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
>;

export const REGISTRATION_BLACK = '#000';
export const PAPER_WHITE = '#fff';
const GREY_TINT = 0.5;
const MARK_ARM_OVERSHOOT = 1.3;

/** Default margin: 8 % of the document's short edge, rounded. */
export function defaultProofMargin(docW: number, docH: number): number {
  return Math.round(Math.min(docW, docH) * 0.08);
}

/** The ink tints for one bar group: evenly spaced from 100 % down to `100/steps` %. */
export function tintSteps(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => (steps - i) / steps);
}

/** Screen approximation of an ink at coverage `k` (0..1), as `rgb(r, g, b)`. */
export function patchColour(ink: Ink, k: number): string {
  const lift = Math.round(255 * (1 - k));
  switch (ink) {
    case 'c':
      return `rgb(${lift}, 255, 255)`;
    case 'm':
      return `rgb(255, ${lift}, 255)`;
    case 'y':
      return `rgb(255, 255, ${lift})`;
    default:
      return `rgb(${lift}, ${lift}, ${lift})`; // black and 50 % grey
  }
}

/** Float slack: a mark clamped to exactly fill the margin touches the work rect, it doesn't overlap it. */
const EPSILON = 1e-9;

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - EPSILON &&
    b.x < a.x + a.w - EPSILON &&
    a.y < b.y + b.h - EPSILON &&
    b.y < a.y + a.h - EPSILON
  );
}

/** A mark's conservative bounding box (arm tip plus half the stroke). */
export function markBounds(m: Mark): Rect {
  const half = m.arm + m.lineWidth / 2;
  return { x: m.cx - half, y: m.cy - half, w: half * 2, h: half * 2 };
}

function buildMarks(docW: number, docH: number, m: number, opts: ProofOptions): Mark[] {
  if (!opts.marks || m < 4) return [];
  const lineWidth = Math.max(1, Math.round(m / 120));
  // Radius max(6, margin × 0.25) — clamped so the whole mark (arms included)
  // still fits inside the margin on a small margin.
  const fit = (m / 2 - lineWidth / 2) / MARK_ARM_OVERSHOOT;
  const r = Math.min(Math.max(6, m * 0.25), fit);
  if (r < 1) return [];
  const arm = r * MARK_ARM_OVERSHOOT;
  const w = docW + 2 * m;
  const h = docH + 2 * m;
  const mid = m / 2;
  const at = (cx: number, cy: number): Mark => ({ cx, cy, r, arm, lineWidth });

  const marks = [at(mid, mid), at(w - mid, mid), at(mid, h - mid), at(w - mid, h - mid)];
  if (opts.edgeMarks) {
    // The bar strip is centred in its margin — exactly where that edge's
    // centre mark would sit — so that one mark is dropped when bars are on.
    const barsOn = (edge: ProofBarEdge) => opts.bars && opts.barEdge === edge;
    marks.push(at(w / 2, mid)); // top
    if (!barsOn('bottom')) marks.push(at(w / 2, h - mid));
    marks.push(at(mid, h / 2)); // left
    if (!barsOn('right')) marks.push(at(w - mid, h / 2));
  }
  return marks;
}

function buildPatches(docW: number, docH: number, m: number, opts: ProofOptions): Patch[] {
  if (!opts.bars) return [];
  const sequence: { ink: Ink; tint: number }[] = [];
  for (const ink of ['c', 'm', 'y', 'k'] as const) {
    for (const tint of tintSteps(opts.steps)) sequence.push({ ink, tint });
  }
  sequence.push({ ink: 'grey', tint: GREY_TINT });

  const horizontal = opts.barEdge === 'bottom';
  const along = horizontal ? docW : docH; // strip stays between the corner marks
  // Side = margin × 0.5, shrunk if the strip would be longer than the edge.
  const side = Math.floor(Math.min(m * 0.5, along / sequence.length));
  if (side < 1) return [];

  const start = Math.round(m + (along - side * sequence.length) / 2);
  const across = horizontal
    ? m + docH + Math.round((m - side) / 2)
    : m + docW + Math.round((m - side) / 2);
  return sequence.map(({ ink, tint }, i) => {
    const pos = start + i * side;
    return {
      x: horizontal ? pos : across,
      y: horizontal ? across : pos,
      w: side,
      h: side,
      ink,
      tint,
      colour: patchColour(ink, tint),
    };
  });
}

/**
 * Pure layout of a proof sheet around a `docW × docH` work area. Every mark
 * and patch lands in the margin; the work rect is asserted clear of both.
 */
export function proofLayout(docW: number, docH: number, opts: ProofOptions): ProofLayout {
  const m = Math.max(0, Math.round(opts.margin));
  const work: Rect = { x: m, y: m, w: docW, h: docH };
  const marks = buildMarks(docW, docH, m, opts);
  const patches = buildPatches(docW, docH, m, opts);

  for (const mark of marks) {
    if (overlaps(markBounds(mark), work)) throw new Error('proof mark overlaps the work area');
  }
  for (const patch of patches) {
    if (overlaps(patch, work)) throw new Error('proof patch overlaps the work area');
  }
  return { width: docW + 2 * m, height: docH + 2 * m, work, marks, patches };
}

/** The four margin strips (top, bottom, left, right) — the paper never touches the work area. */
function marginRects(layout: ProofLayout): Rect[] {
  const { width, height, work } = layout;
  return [
    { x: 0, y: 0, w: width, h: work.y },
    { x: 0, y: work.y + work.h, w: width, h: height - work.y - work.h },
    { x: 0, y: work.y, w: work.x, h: work.h },
    { x: work.x + work.w, y: work.y, w: width - work.x - work.w, h: work.h },
  ].filter((r) => r.w > 0 && r.h > 0);
}

/**
 * Paint a proof sheet onto `ctx` (a canvas of `layout.width × layout.height`).
 * The work is drawn once, at native size, so a plain export's pixels survive
 * byte for byte; transparent paper leaves the margin untouched except for the
 * marks and patches.
 */
export function paintProof(
  ctx: ProofContext,
  work: CanvasImageSource,
  layout: ProofLayout,
  opts: ProofOptions,
): void {
  if (opts.paper === 'white') {
    ctx.fillStyle = PAPER_WHITE;
    for (const r of marginRects(layout)) ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  ctx.drawImage(work, layout.work.x, layout.work.y);

  for (const p of layout.patches) {
    ctx.fillStyle = p.colour;
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }

  ctx.strokeStyle = REGISTRATION_BLACK;
  for (const m of layout.marks) {
    ctx.lineWidth = m.lineWidth;
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2);
    ctx.moveTo(m.cx - m.arm, m.cy);
    ctx.lineTo(m.cx + m.arm, m.cy);
    ctx.moveTo(m.cx, m.cy - m.arm);
    ctx.lineTo(m.cx, m.cy + m.arm);
    ctx.stroke();
  }
}
