//! `ttf_parser::OutlineBuilder` -> anchors converter (Epic 20, story 2). Pure: no fonts, no I/O.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Serialises to the TS `AnchorPoint` exactly (absent handles are omitted).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub point: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle_in: Option<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle_out: Option<Point>,
}

/// One contour; serialises to the TS `VectorPath`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contour {
    pub anchors: Vec<Anchor>,
    pub closed: bool,
}

/// Repeated-start-point tolerance, in anchor-space px.
const EPS: f32 = 1e-3;

/// Collects a glyph outline as cubic anchors, mapping font units to anchor space on the
/// way in: `x = tx + fx * scale`, `y = ty - fy * scale` (font units are y-up, anchor
/// space is y-down).
pub struct AnchorBuilder {
    tx: f32,
    ty: f32,
    scale: f32,
    contours: Vec<Contour>,
    current: Option<Contour>,
}

impl AnchorBuilder {
    pub fn new(tx: f32, ty: f32, scale: f32) -> Self {
        Self {
            tx,
            ty,
            scale,
            contours: Vec::new(),
            current: None,
        }
    }

    fn map(&self, x: f32, y: f32) -> Point {
        Point {
            x: self.tx + x * self.scale,
            y: self.ty - y * self.scale,
        }
    }

    fn flush(&mut self) {
        if let Some(c) = self.current.take() {
            if c.anchors.len() > 1 {
                self.contours.push(c);
            }
        }
    }

    /// Any contour left open (no `close`) is kept as an open contour. Single-point
    /// contours carry no geometry (fonts use them as attachment points) and are dropped.
    pub fn finish(mut self) -> Vec<Contour> {
        self.flush();
        self.contours
    }

    fn cubic(&mut self, c1: Point, c2: Point, p: Point) {
        let Some(cur) = self.current.as_mut() else {
            return;
        };
        if let Some(prev) = cur.anchors.last_mut() {
            prev.handle_out = Some(c1);
        }
        cur.anchors.push(Anchor {
            point: p,
            handle_in: Some(c2),
            handle_out: None,
        });
    }
}

impl ttf_parser::OutlineBuilder for AnchorBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.flush();
        let point = self.map(x, y);
        self.current = Some(Contour {
            anchors: vec![Anchor {
                point,
                handle_in: None,
                handle_out: None,
            }],
            closed: false,
        });
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let point = self.map(x, y);
        if let Some(cur) = self.current.as_mut() {
            cur.anchors.push(Anchor {
                point,
                handle_in: None,
                handle_out: None,
            });
        }
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let Some(p0) = self
            .current
            .as_ref()
            .and_then(|c| c.anchors.last())
            .map(|a| a.point)
        else {
            return;
        };
        let c = self.map(x1, y1);
        let p = self.map(x, y);
        let k = 2.0 / 3.0;
        let c1 = Point {
            x: p0.x + k * (c.x - p0.x),
            y: p0.y + k * (c.y - p0.y),
        };
        let c2 = Point {
            x: p.x + k * (c.x - p.x),
            y: p.y + k * (c.y - p.y),
        };
        self.cubic(c1, c2, p);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let c1 = self.map(x1, y1);
        let c2 = self.map(x2, y2);
        let p = self.map(x, y);
        self.cubic(c1, c2, p);
    }

    fn close(&mut self) {
        let Some(mut cur) = self.current.take() else {
            return;
        };
        cur.closed = true;
        let single_point = cur.anchors.len() < 2;
        if cur.anchors.len() > 1 {
            let first = cur.anchors[0].point;
            let last = cur.anchors[cur.anchors.len() - 1].point;
            if (first.x - last.x).abs() <= EPS && (first.y - last.y).abs() <= EPS {
                let dup = cur.anchors.pop().expect("len > 1");
                cur.anchors[0].handle_in = dup.handle_in;
            }
        }
        if cur.anchors.len() > 1 && !single_point {
            self.contours.push(cur);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ttf_parser::OutlineBuilder;

    fn p(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    fn close_to(a: Point, b: Point) {
        assert!(
            (a.x - b.x).abs() < 1e-5 && (a.y - b.y).abs() < 1e-5,
            "{a:?} != {b:?}"
        );
    }

    #[test]
    fn maps_font_units_y_up_to_anchor_y_down() {
        let mut b = AnchorBuilder::new(10.0, 100.0, 0.5);
        b.move_to(20.0, 40.0);
        b.line_to(60.0, 0.0);
        b.close();
        let c = b.finish();
        close_to(c[0].anchors[0].point, p(20.0, 80.0));
        close_to(c[0].anchors[1].point, p(40.0, 100.0));
    }

    #[test]
    fn quad_is_elevated_to_cubic() {
        // scale 1, ty 0 would flip y; use ty = 0 and feed negative-free numbers by checking
        // the flipped expectations explicitly.
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.quad_to(30.0, 60.0, 60.0, 0.0);
        let c = b.finish();
        let a = &c[0].anchors;
        assert_eq!(a.len(), 2);
        // p0 = (0,0), c = (30,-60), p = (60,0)
        // c1 = p0 + 2/3 (c - p0) = (20,-40); c2 = p + 2/3 (c - p) = (40,-40)
        close_to(a[0].handle_out.expect("c1"), p(20.0, -40.0));
        close_to(a[1].handle_in.expect("c2"), p(40.0, -40.0));
        close_to(a[1].point, p(60.0, 0.0));
        assert!(a[0].handle_in.is_none());
        assert!(a[1].handle_out.is_none());
    }

    #[test]
    fn quad_elevation_matches_the_quadratic_at_midpoint() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.quad_to(50.0, 100.0, 100.0, 0.0);
        let a = b.finish().remove(0).anchors;
        let (p0, c1, c2, p1) = (
            a[0].point,
            a[0].handle_out.unwrap(),
            a[1].handle_in.unwrap(),
            a[1].point,
        );
        // cubic at t = 0.5, quadratic at t = 0.5 with control (50,-100)
        let cx = 0.125 * p0.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p1.x;
        let cy = 0.125 * p0.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p1.y;
        let qx = 0.25 * 0.0 + 0.5 * 50.0 + 0.25 * 100.0;
        let qy = 0.5 * -100.0;
        close_to(p(cx, cy), p(qx, qy));
    }

    #[test]
    fn curve_to_sets_previous_handle_out() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.line_to(10.0, 0.0);
        b.curve_to(15.0, 5.0, 20.0, 5.0, 25.0, 0.0);
        let a = b.finish().remove(0).anchors;
        assert_eq!(a.len(), 3);
        assert!(a[0].handle_out.is_none());
        close_to(a[1].handle_out.expect("c1 on previous"), p(15.0, -5.0));
        close_to(a[2].handle_in.expect("c2 on new"), p(20.0, -5.0));
        assert!(a[1].handle_in.is_none());
        assert!(a[2].handle_out.is_none());
    }

    #[test]
    fn closed_contour_with_repeated_start_is_merged_and_keeps_handle() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.line_to(10.0, 0.0);
        b.curve_to(10.0, 5.0, 5.0, 10.0, 0.0, 0.0); // ends at the start point
        b.close();
        let c = b.finish();
        assert_eq!(c.len(), 1);
        assert!(c[0].closed);
        assert_eq!(c[0].anchors.len(), 2);
        close_to(
            c[0].anchors[0].handle_in.expect("moved handle"),
            p(5.0, -10.0),
        );
        close_to(c[0].anchors[1].handle_out.expect("c1"), p(10.0, -5.0));
    }

    #[test]
    fn contour_without_repeated_start_is_left_alone() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.line_to(10.0, 0.0);
        b.line_to(10.0, 10.0);
        b.close();
        let c = b.finish();
        assert!(c[0].closed);
        assert_eq!(c[0].anchors.len(), 3);
        assert!(c[0].anchors[0].handle_in.is_none());
    }

    #[test]
    fn single_point_contours_are_dropped() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(3.0, 3.0);
        b.close();
        b.move_to(0.0, 0.0);
        b.line_to(1.0, 0.0);
        b.line_to(1.0, 1.0);
        b.close();
        b.move_to(9.0, 9.0);
        assert_eq!(b.finish().len(), 1);
    }

    #[test]
    fn multiple_contours_and_open_tail() {
        let mut b = AnchorBuilder::new(0.0, 0.0, 1.0);
        b.move_to(0.0, 0.0);
        b.line_to(1.0, 0.0);
        b.close();
        b.move_to(5.0, 5.0);
        b.line_to(6.0, 5.0);
        let c = b.finish();
        assert_eq!(c.len(), 2);
        assert!(c[0].closed);
        assert!(!c[1].closed);
    }

    #[test]
    fn serialises_to_ts_anchor_shape() {
        let a = Anchor {
            point: p(1.0, 2.0),
            handle_in: None,
            handle_out: Some(p(3.0, 4.0)),
        };
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"point": {"x": 1.0, "y": 2.0}, "handleOut": {"x": 3.0, "y": 4.0}})
        );
    }
}

/// Signed area of a contour's control polygon (anchor, handle_out, next
/// handle_in, next anchor, …) in anchor space (y down). The control polygon's
/// sign matches the curve's for real glyph outlines, which is all orientation
/// needs.
pub fn signed_area(contour: &Contour) -> f32 {
    let mut pts: Vec<&Point> = Vec::new();
    let n = contour.anchors.len();
    for i in 0..n {
        let a = &contour.anchors[i];
        pts.push(&a.point);
        if i + 1 < n || contour.closed {
            let b = &contour.anchors[(i + 1) % n];
            if let Some(h) = &a.handle_out {
                pts.push(h);
            }
            if let Some(h) = &b.handle_in {
                pts.push(h);
            }
        }
    }
    let m = pts.len();
    let mut twice = 0.0;
    for i in 0..m {
        let (p, q) = (pts[i], pts[(i + 1) % m]);
        twice += p.x * q.y - q.x * p.y;
    }
    twice / 2.0
}

/// Reverse a contour's direction: anchors in reverse order, each anchor's
/// handles swapped (what was its incoming handle is now outgoing).
pub fn reverse(contour: &mut Contour) {
    contour.anchors.reverse();
    for a in &mut contour.anchors {
        std::mem::swap(&mut a.handle_in, &mut a.handle_out);
    }
}

/// Give one glyph's contours a canonical orientation: its largest contour
/// (the outer) runs positive. Reversing the whole glyph keeps its own
/// outer/counter relationship intact, so every glyph unions with its
/// neighbours under nonzero fill instead of cancelling where tracking makes
/// them overlap.
pub fn normalise_glyph(contours: &mut [Contour]) {
    let largest = contours
        .iter()
        .map(signed_area)
        .max_by(|a, b| a.abs().total_cmp(&b.abs()));
    if matches!(largest, Some(a) if a < 0.0) {
        for c in contours.iter_mut() {
            reverse(c);
        }
    }
}
