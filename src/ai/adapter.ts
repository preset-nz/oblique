/**
 * AI backend adapter (Epic 17, story 1 —
 * `guidance/projects/oblique/features/17-ml-masking-and-fill/ai-backends-settings.md`).
 *
 * One task vocabulary, several swappable HTTP/sidecar backends behind it
 * (`design/licensing.md` §AI models & backends, `design/architecture.md`'s
 * AI-adapter note). No backend is a build dependency — the app works fully
 * with none configured. Every method is optional on a driver; a driver
 * declares what it actually supports via `capabilities` so the UI can
 * disable affordances the configured backend can't serve, per this epic's
 * acceptance ("every AI affordance is disabled with an honest hint").
 *
 * Request/result shapes below are the smallest useful contract for this
 * story (no model runs yet) — the stories that implement each task
 * (segment: story 2, inpaint: story 3) may extend their own shape without
 * touching this file's other tasks.
 */

export type AiTask =
  | 'generate'
  | 'inpaint'
  | 'outpaint'
  | 'upscale'
  | 'segment'
  | 'caption'
  | 'removeBackground';

export interface HealthResult {
  ok: boolean;
  detail: string;
}

export interface GenerateOptions {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
}

export interface InpaintOptions {
  /** RGBA8 source image bytes (PNG-encoded). */
  image: Uint8Array;
  /** RGBA8 mask bytes (PNG-encoded); alpha (or luma) selects the fill region. */
  mask: Uint8Array;
  prompt: string;
  seed?: number;
}

export interface OutpaintOptions {
  image: Uint8Array;
  expandPx: number;
  prompt: string;
  seed?: number;
}

export interface UpscaleOptions {
  image: Uint8Array;
  factor: number;
}

/** A SAM-style point prompt: `label` 1 = positive (include), 0 = negative (exclude). */
export interface SegmentPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

/** Bounding-box prompt, corner coordinates (not width/height) — the sidecar's own `segment` request shape (segment-to-vector.md). */
export interface SegmentBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Segment request (story 2, segment-to-vector.md — the smallest useful
 * shape story 1 left provisional, now pinned to the sidecar's fixed wire
 * contract). `image`/`width`/`height` are the target node's cooked RGBA8 at
 * WORKING resolution — coordinates in `points`/`box`/`mask` are in that same
 * buffer's pixel space; the caller (`src/canvas/smartSelect/`) maps
 * document <-> buffer, this module never sees document space.
 */
export interface SegmentOptions {
  /** RGBA8, `width * height * 4` bytes. */
  image: Uint8Array;
  width: number;
  height: number;
  points?: SegmentPoint[];
  box?: SegmentBox | null;
  /**
   * Optional 256x256 u8 coarse mask (0/255) — the outline prompt
   * (segment-to-vector.md's "can I also draw a vector outline" note):
   * biases the decoder toward a drawn region rather than merely bounding it.
   */
  mask?: Uint8Array;
}

export interface CaptionOptions {
  image: Uint8Array;
}

export interface RemoveBackgroundOptions {
  image: Uint8Array;
}

export interface ImageResult {
  image: Uint8Array;
}

export interface CaptionResult {
  caption: string;
}

export interface SegmentResult {
  /** Single-channel u8 mask, `width * height` bytes, same buffer pixel space as the request. */
  mask: Uint8Array;
  /**
   * Closed contours, sidecar-traced (epic decision: tracing lives
   * server-side), outer contours only — in the REQUEST's buffer pixel
   * space, not document space (segment-to-vector.md's Coordinates note).
   * The caller maps these to document space before writing them into
   * `scene/marquee.ts`'s `polygons` marquee variant.
   */
  polygons: Array<Array<{ x: number; y: number }>>;
}

/**
 * A backend driver. `capabilities` is the source of truth for what a driver
 * supports — the presence of a method alone isn't checked by callers,
 * `canX(driver)` below is.
 */
export interface AiAdapter {
  readonly capabilities: ReadonlySet<AiTask>;
  health(): Promise<HealthResult>;
  generate?(options: GenerateOptions): Promise<ImageResult>;
  inpaint?(options: InpaintOptions): Promise<ImageResult>;
  outpaint?(options: OutpaintOptions): Promise<ImageResult>;
  upscale?(options: UpscaleOptions): Promise<ImageResult>;
  segment?(options: SegmentOptions): Promise<SegmentResult>;
  caption?(options: CaptionOptions): Promise<CaptionResult>;
  removeBackground?(options: RemoveBackgroundOptions): Promise<ImageResult>;
}

function hasCapability(driver: AiAdapter, task: AiTask): boolean {
  return driver.capabilities.has(task);
}

export const canGenerate = (driver: AiAdapter): boolean => hasCapability(driver, 'generate');
export const canInpaint = (driver: AiAdapter): boolean => hasCapability(driver, 'inpaint');
export const canOutpaint = (driver: AiAdapter): boolean => hasCapability(driver, 'outpaint');
export const canUpscale = (driver: AiAdapter): boolean => hasCapability(driver, 'upscale');
export const canSegment = (driver: AiAdapter): boolean => hasCapability(driver, 'segment');
export const canCaption = (driver: AiAdapter): boolean => hasCapability(driver, 'caption');
export const canRemoveBackground = (driver: AiAdapter): boolean =>
  hasCapability(driver, 'removeBackground');
