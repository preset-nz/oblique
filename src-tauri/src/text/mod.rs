//! Text engine: shaping, line layout and glyph outlines. No webview or Tauri types in
//! here, so a headless `oblique render` can call it directly (Epic 20).

pub mod outline;

use std::fmt;

use serde::{Deserialize, Serialize};

use outline::AnchorBuilder;
pub use outline::Contour;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub content: String,
    pub postscript_name: String,
    /// Document px (em size).
    pub font_size: f32,
    /// 1/1000 em, added after every glyph cluster.
    pub tracking: f32,
    /// Percent of the font's own kern pairs: 0 = off, 100 = the font's pairs, 200 = doubled.
    /// Clamped to 0..=200 (the UI range). See `shape_line` for how the in-between is made.
    pub kerning: f32,
    /// Multiple of `font_size`.
    pub line_height: f32,
    pub align: Align,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMetrics {
    pub x_start: f32,
    pub width: f32,
    pub baseline_y: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGeometry {
    /// Anchor space (origin = align anchor on the first baseline, y down); fill rule nonzero.
    pub paths: Vec<Contour>,
    /// One per content line, including empty ones.
    pub lines: Vec<LineMetrics>,
    /// Px above the baseline (positive).
    pub ascent: f32,
    /// Px below the baseline (positive).
    pub descent: f32,
    /// Tight union of glyph bboxes in anchor space; `None` when there is no ink.
    pub bounds: Option<Rect>,
}

#[derive(Debug)]
pub enum TextError {
    FontNotFound(String),
    Parse,
}

impl fmt::Display for TextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TextError::FontNotFound(name) => write!(f, "font not found: {name}"),
            TextError::Parse => write!(f, "font could not be parsed"),
        }
    }
}

impl std::error::Error for TextError {}

/// Union accumulator for bounds, in anchor space.
struct Bounds {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

pub fn layout(db: &fontdb::Database, spec: &TextSpec) -> Result<TextGeometry, TextError> {
    let id = db
        .faces()
        .find(|f| f.post_script_name == spec.postscript_name)
        .map(|f| f.id)
        .ok_or_else(|| TextError::FontNotFound(spec.postscript_name.clone()))?;
    // The `rustybuzz::Face` borrows the font data, so everything runs inside the closure.
    db.with_face_data(id, |data, index| layout_face(data, index, spec))
        .ok_or_else(|| TextError::FontNotFound(spec.postscript_name.clone()))?
}

/// One shaped glyph, positions in font units.
struct ShapedGlyph {
    glyph_id: u32,
    cluster: u32,
    x_advance: f32,
    x_offset: f32,
    y_offset: f32,
}

fn shape_once(face: &rustybuzz::Face, line: &str, kern: bool) -> Vec<ShapedGlyph> {
    let no_kern = [rustybuzz::Feature::new(
        rustybuzz::ttf_parser::Tag::from_bytes(b"kern"),
        0,
        ..,
    )];
    let features: &[rustybuzz::Feature] = if kern { &[] } else { &no_kern };
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(line);
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(face, features, buffer);
    shaped
        .glyph_infos()
        .iter()
        .zip(shaped.glyph_positions())
        .map(|(info, pos)| ShapedGlyph {
            glyph_id: info.glyph_id,
            cluster: info.cluster,
            x_advance: pos.x_advance as f32,
            x_offset: pos.x_offset as f32,
            y_offset: pos.y_offset as f32,
        })
        .collect()
}

/// Shapes one line at a kerning amount (percent of the font's kern pairs).
///
/// 0 shapes once with the `kern` feature off and 100 shapes once with the font's defaults.
/// Anything between (or beyond) shapes twice, kern on and kern off, and blends each glyph's
/// `x_advance` and `x_offset` as `off + k * (on - off)` with `k = kerning / 100`, in font units.
/// Kerning is positioning-only, so the two runs normally have the same glyphs. Some fonts'
/// kern lookups interact with other features and change the glyph sequence; then there is
/// nothing to blend, so the kern-on result is used when `kerning >= 100` and the kern-off
/// result otherwise.
fn shape_line(face: &rustybuzz::Face, line: &str, kerning: f32) -> Vec<ShapedGlyph> {
    let kerning = if kerning.is_finite() {
        kerning.clamp(0.0, 200.0)
    } else {
        100.0
    };
    if kerning <= 0.0 {
        return shape_once(face, line, false);
    }
    if kerning == 100.0 {
        return shape_once(face, line, true);
    }
    let on = shape_once(face, line, true);
    let off = shape_once(face, line, false);
    let same_glyphs =
        on.len() == off.len() && on.iter().zip(&off).all(|(a, b)| a.glyph_id == b.glyph_id);
    if !same_glyphs {
        return if kerning >= 100.0 { on } else { off };
    }
    let k = kerning / 100.0;
    on.iter()
        .zip(&off)
        .map(|(on, off)| ShapedGlyph {
            glyph_id: on.glyph_id,
            cluster: on.cluster,
            x_advance: off.x_advance + k * (on.x_advance - off.x_advance),
            x_offset: off.x_offset + k * (on.x_offset - off.x_offset),
            y_offset: on.y_offset,
        })
        .collect()
}

fn layout_face(data: &[u8], index: u32, spec: &TextSpec) -> Result<TextGeometry, TextError> {
    let face = rustybuzz::Face::from_slice(data, index).ok_or(TextError::Parse)?;
    let units_per_em = face.units_per_em() as f32;
    if units_per_em <= 0.0 {
        return Err(TextError::Parse);
    }
    let scale = spec.font_size / units_per_em;
    let tracking_px = spec.tracking * spec.font_size / 1000.0;

    let mut paths = Vec::new();
    let mut lines = Vec::new();
    let mut bounds: Option<Bounds> = None;

    for (i, line) in spec.content.split('\n').enumerate() {
        let baseline_y = i as f32 * spec.line_height * spec.font_size;

        let shaped = if line.is_empty() {
            Vec::new()
        } else {
            shape_line(&face, line, spec.kerning)
        };

        // Pass 1: pen positions (the line width is needed for alignment before outlining).
        let mut origins: Vec<(f32, rustybuzz::ttf_parser::GlyphId, f32)> = Vec::new();
        let mut pen = 0.0_f32;
        for (g, glyph) in shaped.iter().enumerate() {
            origins.push((
                pen + glyph.x_offset * scale,
                rustybuzz::ttf_parser::GlyphId(glyph.glyph_id as u16),
                glyph.y_offset * scale,
            ));
            pen += glyph.x_advance * scale;
            let cluster_ends = shaped.get(g + 1).is_none_or(|n| n.cluster != glyph.cluster);
            if cluster_ends {
                pen += tracking_px;
            }
        }
        let width = pen;
        let x_start = match spec.align {
            Align::Left => 0.0,
            Align::Center => -width / 2.0,
            Align::Right => -width,
        };
        lines.push(LineMetrics {
            x_start,
            width,
            baseline_y,
        });

        // Pass 2: outlines.
        for (origin_x, glyph, y_offset) in origins {
            let mut builder = AnchorBuilder::new(x_start + origin_x, baseline_y - y_offset, scale);
            let Some(bbox) = face.outline_glyph(glyph, &mut builder) else {
                continue;
            };
            let mut glyph_paths = builder.finish();
            outline::normalise_glyph(&mut glyph_paths);
            paths.extend(glyph_paths);
            let gx0 = x_start + origin_x + bbox.x_min as f32 * scale;
            let gx1 = x_start + origin_x + bbox.x_max as f32 * scale;
            let gy0 = baseline_y - y_offset - bbox.y_max as f32 * scale;
            let gy1 = baseline_y - y_offset - bbox.y_min as f32 * scale;
            bounds = Some(match bounds {
                None => Bounds {
                    x0: gx0,
                    y0: gy0,
                    x1: gx1,
                    y1: gy1,
                },
                Some(b) => Bounds {
                    x0: b.x0.min(gx0),
                    y0: b.y0.min(gy0),
                    x1: b.x1.max(gx1),
                    y1: b.y1.max(gy1),
                },
            });
        }
    }

    Ok(TextGeometry {
        paths,
        lines,
        ascent: face.ascender() as f32 * scale,
        descent: -(face.descender() as f32) * scale,
        bounds: bounds.map(|b| Rect {
            x: b.x0,
            y: b.y0,
            w: b.x1 - b.x0,
            h: b.y1 - b.y0,
        }),
    })
}

#[cfg(test)]
mod tests;
