//! Oblique's document on rhizome (Epic 21, guidance `projects/oblique/features/21-rhizome/`):
//! the object model, its commands, and the document host.
//!
//! - `/document/document`: the scene-level fields, made with every new document (`seed`).
//! - `/layers/<id>`: pixel, vector and text layers, named by their Oblique id; the stack is
//!   the order `stack` on `/layers`, index 0 = top.
//! - `/layers/<id>/<modifier id>`: modifiers, one kind per op from the sidecar's `list_ops`
//!   (`op.<name>`), in the layer's order `modifiers`. An op's params are namespaced
//!   (`params.<name>`) so they never meet the modifier's own values (`enabled`).
//! - A modifier mask is a binding from a vector or text layer onto the modifier's `mask`
//!   slot, carrying the mask reference's own values.
//!
//! The webview edits only through commands (rhizome decision 46).

use std::sync::Arc;

use rhizome_core::{Edit, NodeId, NodeType, On, Origin, Ref, Shape, Value, ValueSpec};
use rhizome_pom::{payload, Commands, Error, Kinds, ObjectModel, Pom};
use serde::Deserialize;
use serde_json::{json, Value as Json};

mod host;
#[cfg(test)]
mod tests;

pub use host::DocumentHost;

pub const EXTENSION: &str = "oblique";

/// How far a duplicate sits from its original in x and y, in document pixels
/// (src/scene/store.ts `DUPLICATE_OFFSET_PX`).
pub const DUPLICATE_OFFSET_PX: f64 = 16.0;

const BLEND: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "difference",
];

/// The keys a layer's transform and props live under. A locked layer refuses `transform2d.*`;
/// the compositing props stay writable.
const TRANSFORM_AND_PROPS: &[&str] = &[
    "transform2d.position",
    "transform2d.scale",
    "transform2d.rotation",
    "label",
    "visible",
    "blendMode",
    "opacity",
    "output",
];

/// POM built-in commands that write the tree. Oblique's own commands replace them, so they refuse.
const NOT_MOVED: &[&str] = &[
    "value.set",
    "node.add",
    "edit.delete",
    "edit.duplicate",
    "edit.paste",
    "preset.apply",
    "preset.save",
    "preset.update",
    "preset.rename",
    "preset.delete",
    "preset.import",
];

const TEXT_KEYS: &[&str] = &[
    "content",
    "font",
    "fontSize",
    "tracking",
    "kerning",
    "lineHeight",
    "align",
    "fill",
    "stroke",
    "position",
];

/// One op as `list_ops` reports it (src/sidecar/opsCache.ts `OpDescriptor`).
#[derive(Clone, Debug, Deserialize)]
pub struct Op {
    pub name: String,
    /// The panel label ("Gaussian blur"), for undo step names. Optional on the wire.
    #[serde(default)]
    pub label: Option<String>,
    /// One sentence on what the op does to the picture. Optional on the wire.
    #[serde(default)]
    pub description: Option<String>,
    /// What the op is to someone browsing (`colour`, `film`): an id from the sidecar's
    /// category list. Optional on the wire.
    #[serde(default)]
    pub category: Option<String>,
    pub params: Vec<OpParam>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct OpParam {
    pub name: String,
    /// The panel label ("Cell size"), for undo step names. Optional on the wire.
    #[serde(default)]
    pub label: Option<String>,
    /// One sentence on what the control does. Optional on the wire.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub default: Json,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(default)]
    pub choices: Vec<String>,
    /// Display labels for some of the choices, by choice. Optional on the wire.
    #[serde(default)]
    pub choice_labels: std::collections::BTreeMap<String, String>,
}

/// The op catalogue: what modifier kinds exist (rhizome decision 52).
#[derive(Default)]
pub struct Catalogue(pub Vec<Op>);

/// The op catalogue as the sidecar reports it, for tools that have no window to ask:
/// `OBLIQUE_OPS` (a `list_ops` JSON file) if set, else read from the sidecar's own `OPS`
/// through `uv`. Shared by the `real_projects` test and `just docs`.
pub fn sidecar_catalogue() -> Result<Catalogue, String> {
    let text = match std::env::var("OBLIQUE_OPS") {
        Ok(path) => std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?,
        Err(_) => {
            let sidecar = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar");
            let out = std::process::Command::new("uv")
                .arg("run")
                .arg("--project")
                .arg(&sidecar)
                .args(["python", "-I", "-c"])
                .arg(
                    "import json, sys\nsys.path.insert(0, sys.argv[1])\nfrom ops import OPS\n\
                     print(json.dumps([o.to_dict() for o in OPS.values()]))",
                )
                .arg(&sidecar)
                .output()
                .map_err(|e| {
                    format!("uv: {e} (set OBLIQUE_OPS to a list_ops JSON file instead)")
                })?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).into_owned());
            }
            String::from_utf8(out.stdout).map_err(|e| e.to_string())?
        }
    };
    let ops: Vec<Op> = serde_json::from_str(&text)
        .map_err(|e| format!("the op catalogue as list_ops JSON: {e}"))?;
    Ok(Catalogue(ops))
}

pub struct Oblique;

/// A modifier's node type: `op.<name>`.
pub fn op_type(name: &str) -> String {
    format!("op.{name}")
}

/// Where an op's params live on a modifier (src/rhizome/adapter.ts `PARAM_PREFIX`).
const PARAM_PREFIX: &str = "params.";

/// An op param's value key on a modifier: `params.<name>`.
pub fn param_key(name: &str) -> String {
    format!("{PARAM_PREFIX}{name}")
}

/// An op param as a value. The sidecar's label and description come across when it has them
/// (it has no units); missing words stay unset rather than being made up.
fn param_spec(p: &OpParam) -> Option<ValueSpec> {
    let mut spec = param_value(p)?;
    if let Some(label) = &p.label {
        spec = spec.label(label);
    }
    if let Some(description) = &p.description {
        spec = spec.description(description);
    }
    if !p.choice_labels.is_empty() {
        let labels: Vec<(&str, &str)> = p
            .choice_labels
            .iter()
            // a label for a choice the param lacks is dropped, not a panic on a bad catalogue
            .filter(|(choice, _)| p.choices.contains(choice))
            .map(|(choice, label)| (choice.as_str(), label.as_str()))
            .collect();
        spec = spec.choice_labels(&labels);
    }
    Some(spec)
}

fn param_value(p: &OpParam) -> Option<ValueSpec> {
    let key = param_key(&p.name);
    let f = |d: &Json| d.as_f64().unwrap_or(0.0);
    Some(match p.kind.as_str() {
        // an op's max is the slider's end; a typed value may go past it (rhizome decision 53)
        // a missing end is no limit on that side; a given min always holds
        "float" => match (p.min, p.max) {
            (None, None) => ValueSpec::float_unbounded(&*key, f(&p.default)),
            (lo, hi) => ValueSpec::float(
                &*key,
                lo.unwrap_or(-f64::MAX)..=hi.unwrap_or(f64::MAX),
                f(&p.default),
            )
            .soft_max(),
        },
        "int" => {
            let lo = p.min.unwrap_or(i64::MIN as f64) as i64;
            let hi = p.max.unwrap_or(i64::MAX as f64) as i64;
            ValueSpec::int(&*key, lo..=hi, p.default.as_i64().unwrap_or(0)).soft_max()
        }
        "bool" => ValueSpec::bool(&*key, p.default.as_bool().unwrap_or(false)),
        "enum" => {
            let choices: Vec<&str> = p.choices.iter().map(String::as_str).collect();
            let d = p
                .default
                .as_str()
                .or(choices.first().copied())
                .unwrap_or("");
            ValueSpec::choice(&*key, &choices, d)
        }
        "color" => ValueSpec::text(&*key, p.default.as_str().unwrap_or("#000000")),
        _ => return None,
    })
}

fn transform2d() -> Shape {
    Shape::record([
        ("x", Shape::Float),
        ("y", Shape::Float),
        ("scaleX", Shape::Float),
        ("scaleY", Shape::Float),
        ("rotation", Shape::Float),
    ])
}

fn point() -> Shape {
    Shape::record([("x", Shape::Float), ("y", Shape::Float)])
}

/// What every layer has (`SceneNode`).
fn layer(name: &str) -> NodeType {
    NodeType::new(name)
        .group("layer")
        .in_categories(&["layers"])
        .text("label", "")
        .described("Name", "What the layer is called in the layer list.")
        .choice("state", &["active", "locked"], "active")
        .described(
            "State",
            "A locked layer can't be moved, scaled or rotated; its look can still change.",
        )
        .choice("output", &["image", "mask", "transform", "data"], "image")
        .described(
            "Output",
            "What the layer hands on: its picture, a mask for other layers, a transform, or data.",
        )
        .bool("visible", true)
        .described("Visible", "Shows or hides the layer on the canvas.")
        .choice("blendMode", BLEND, "normal")
        .described(
            "Blend mode",
            "How the layer's colours mix with the layers beneath it.",
        )
        .float("opacity", 0.0..=1.0, 1.0)
        .described(
            "Opacity",
            "How solid the layer is, from fully see-through (0) to fully solid (1).",
        )
        // transform2d is optional in Oblique (identity when absent): split so a drag writes
        // one key, and "set" tells present from absent
        .vec2("transform2d.position", [0.0, 0.0])
        .described(
            "Position",
            "Where the layer sits, as a shift in document pixels.",
        )
        .unit("px")
        .vec2("transform2d.scale", [1.0, 1.0])
        .described(
            "Scale",
            "How much the layer is stretched across and down; 1 is its own size.",
        )
        .float_unbounded("transform2d.rotation", 0.0)
        .described(
            "Rotation",
            "How far the layer is turned around its own centre.",
        )
        .unit("rad")
        .floats("transform", &[0.0; 16])
        .described(
            "Transform",
            "A full transform handed on to other layers when the output is a transform.",
        )
        .reference("cameraId")
}

/// The values a modifier mask carries (`VectorMaskRef` less its node).
fn mask_values() -> Vec<ValueSpec> {
    vec![
        ValueSpec::text("refId", "").described("Mask layer", "Which layer shapes the mask."),
        ValueSpec::float_unbounded("featherPx", 0.0)
            .described("Feather", "Softens the mask's edge so the effect fades in.")
            .unit("px"),
        ValueSpec::float_unbounded("expand", 0.0)
            .described(
                "Expand",
                "Grows the masked area outwards, or shrinks it when negative.",
            )
            .unit("px"),
        ValueSpec::bool("invert", false)
            .described("Invert", "Swaps the masked and unmasked areas."),
        ValueSpec::shaped(
            "space",
            Shape::optional(Shape::choice(&["document", "node"])),
        )
        .described(
            "Space",
            "Whether the mask stays fixed on the document or travels with the layer.",
        ),
        ValueSpec::shaped("attachTransform", Shape::optional(transform2d())).described(
            "Attached transform",
            "Where the mask sits relative to the layer when it travels with it.",
        ),
    ]
}

impl ObjectModel for Oblique {
    const NAME: &'static str = "Oblique";
    const EXTENSION: &'static str = EXTENSION;
    type Projection = ();
    type Context = Catalogue;

    fn kinds(k: &mut Kinds, ops: &Catalogue) {
        k.category("document", Origin::Loaded)
            .category("layers", Origin::Loaded);
        k.kind(
            NodeType::new("document")
                .label("Document")
                .summary("The canvas everything is built on: its size, background and notes.")
                .group("document")
                .in_categories(&["document"])
                .text("sceneId", "")
                .described("Scene id", "An internal id for the document; you never need to change it.")
                .vec2("documentSize", [0.0, 0.0])
                .described("Size", "The width and height of the canvas.")
                .unit("px")
                .choice("resolution", &["draft", "working", "baked"], "working")
                .described(
                    "Resolution",
                    "How much detail is shown while you work: draft is quickest, baked is full size.",
                )
                .text("note", "")
                .described("Note", "Free text kept with the document.")
                .shaped(
                    "background",
                    Shape::optional(Shape::record([
                        ("type", Shape::choice(&["color", "image"])),
                        ("color", Shape::optional(Shape::Text)),
                        ("sourcePath", Shape::optional(Shape::Text)),
                        ("sourceSize", Shape::optional(Shape::Vec2)),
                    ])),
                )
                .described("Background", "What sits behind every layer: a flat colour or an image.")
                .reference("defaultCameraId"),
        )
        .not_deletable()
        .not_duplicable()
        .max_per_parent(1);

        k.kind(
            layer("pixel")
                .label("Pixel layer")
                .summary("A picture, such as a photo you've opened.")
                .reference("source")
                .vec2("sourceSize", [0.0, 0.0])
                .described(
                    "Source size",
                    "The width and height of the picture the layer shows.",
                )
                .unit("px"),
        );
        k.kind(
            layer("vector")
                .label("Vector layer")
                .summary("Drawn shapes with smooth edges, which can also mask other layers.")
                .shaped(
                    "paths",
                    Shape::list(Shape::record([
                        (
                            "anchors",
                            Shape::list(Shape::record([
                                ("point", point()),
                                ("handleIn", Shape::optional(point())),
                                ("handleOut", Shape::optional(point())),
                            ])),
                        ),
                        ("closed", Shape::Bool),
                    ])),
                )
                .described("Paths", "The outlines that make up the shape, point by point.")
                .choice("fillRule", &["nonzero", "evenodd"], "nonzero")
                .described(
                    "Fill rule",
                    "How overlapping outlines fill: non-zero fills them all, even-odd leaves holes where they cross.",
                )
                .bindable(mask_values()),
        );
        k.kind(
            layer("text")
                .label("Text layer")
                .summary("Typed words in any installed font, which can also mask other layers.")
                .text("content", "")
                .described("Content", "The words the layer shows.")
                .shaped(
                    "font",
                    Shape::record([
                        ("family", Shape::Text),
                        ("style", Shape::Text),
                        ("postscriptName", Shape::Text),
                        ("weight", Shape::Float),
                        ("italic", Shape::Bool),
                        ("category", Shape::Text),
                    ]),
                )
                .described("Font", "Which typeface the words are set in.")
                .float_unbounded("fontSize", 72.0)
                .described("Size", "How tall the letters are.")
                .unit("px")
                .float_unbounded("tracking", 0.0)
                .described(
                    "Tracking",
                    "Opens up or tightens the space between every letter, in thousandths of an em.",
                )
                .float("kerning", 0.0..=200.0, 100.0)
                .described(
                    "Kerning",
                    "How much of the font's own pair spacing is used; 100 is as the font intends.",
                )
                .float_unbounded("lineHeight", 1.2)
                .described(
                    "Line height",
                    "The space between lines, as a multiple of the font size.",
                )
                .choice("align", &["left", "center", "right"], "left")
                .described("Align", "Which edge the lines of text line up against.")
                .shaped("fill", Shape::optional(Shape::Text))
                .described(
                    "Fill",
                    "The colour inside the letters; empty leaves them unfilled.",
                )
                .shaped(
                    "stroke",
                    Shape::optional(Shape::record([
                        ("color", Shape::Text),
                        ("width", Shape::Float),
                    ])),
                )
                .described(
                    "Stroke",
                    "An outline around the letters, with its own colour and width.",
                )
                .shaped("position", point())
                .described("Text origin", "Where the text starts on the canvas.")
                .bindable(mask_values()),
        );
        for op in &ops.0 {
            let mut t = NodeType::new(&op_type(&op.name))
                .in_categories(&["layers"])
                .group("modifier");
            if let Some(label) = &op.label {
                t = t.label(label);
            }
            if let Some(description) = &op.description {
                t = t.summary(description);
            }
            if let Some(category) = &op.category {
                t = t.category(category);
            }
            t = t
                .bool("enabled", true)
                .described(
                    "Enabled",
                    "Turns the effect on or off without losing its settings.",
                )
                .slot("mask");
            for p in &op.params {
                if let Some(spec) = param_spec(p) {
                    t = t.value(spec);
                }
            }
            k.kind(t);
        }
    }

    /// Oblique's empty document: size 0×0 until the first import or the document setup sets
    /// it, resolution `working` (store.ts `makeEmptyScene`).
    fn seed(tx: &mut Edit<'_>, _: &Catalogue) -> rhizome_core::Result<()> {
        let doc = tx.add("/document", "document", "document")?;
        tx.set_value(doc, "sceneId", Value::Text(doc.to_string()))
    }

    fn commands(c: &mut Commands<Self>) {
        // A layer TypeScript built, on top of the stack. Its id is its name: a duplicate is
        // refused.
        c.add(
            "layer.add",
            |_| "New Layer".into(),
            |_, p| p.get("node").is_some_and(Json::is_object),
            |d, p| {
                let a: NodeArgs = payload(p)?;
                let label = format!("New {}", a.node["type"].as_str().unwrap_or("layer"));
                let (_, commit) = d.edit(&label, |tx| {
                    let at = add_layer(tx, &a.node)?;
                    let mut stack: Vec<NodeId> = stack_of(tx);
                    stack.retain(|id| *id != at);
                    stack.insert(0, at);
                    tx.set_order("/layers", "stack", stack)
                })?;
                Ok(commit.into())
            },
        );
        // Transform and layer props; a locked layer refuses its transform only (lock-state-machine.md). Same
        // shape as POM's built-in `values.set`, which this replaces.
        c.add(
            "values.set",
            |_| "Set Values".into(),
            |_, p| p.get("changes").is_some_and(Json::is_array),
            |d, p| {
                let a: SetManyArgs = payload(p)?;
                let label = match a.changes.as_slice() {
                    [one] => format!("Set {}", one.key),
                    _ => "Set Values".to_string(),
                };
                let (_, commit) = d.edit(&label, |tx| {
                    for ch in &a.changes {
                        if !TRANSFORM_AND_PROPS.contains(&ch.key.as_str()) {
                            return Err(structural(format!("`{}` isn't on rhizome yet", ch.key)));
                        }
                        let at = live(tx, &ch.at)?;
                        // compositing-only props stay writable on a locked layer
                        // (lock-state-machine.md); only the transform is guarded
                        if ch.key.starts_with("transform2d.") {
                            refuse_locked(tx, at)?;
                        }
                        set(tx, at, &ch.key, &ch.value)?;
                    }
                    Ok(())
                })?;
                Ok(commit.into())
            },
        );
        // Text props, with the label following the content while it's automatic.
        c.add(
            "text.set",
            |_| "Edit Text".into(),
            |_, p| p.get("patch").is_some_and(Json::is_object),
            |d, p| {
                let a: TextArgs = payload(p)?;
                let (_, commit) = d.edit("Edit Text", |tx| {
                    let at = live(tx, &a.at)?;
                    if tx.at(at).map(|n| n.type_name() != "text").unwrap_or(true) {
                        return Err(structural(format!("{} isn't a text layer", a.at)));
                    }
                    refuse_locked(tx, at)?;
                    let n = tx.at(at).expect("live");
                    let text = |k: &str| match n.value(k) {
                        Some(Value::Text(s)) => s,
                        _ => String::new(),
                    };
                    let (label, content) = (text("label"), text("content"));
                    for (k, v) in a.patch.as_object().into_iter().flatten() {
                        if !TEXT_KEYS.contains(&k.as_str()) {
                            return Err(structural(format!("`{k}` isn't a text prop")));
                        }
                        set(tx, at, k, v)?;
                    }
                    let new = a.patch.get("content").and_then(Json::as_str);
                    if let Some(new) = new.filter(|_| label == text_label(&content)) {
                        tx.set_value(at, "label", Value::Text(text_label(new)))?;
                    }
                    Ok(())
                })?;
                Ok(commit.into())
            },
        );
        // Points a pixel layer at another file. With a size that differs from the layer's it also
        // fits the transform into the old footprint and refits the node-space masks it
        // consumes (image-source.md decisions 5 and 6), all in one undo step.
        c.add(
            "layer.set_source",
            |_| "Replace Image".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("sourcePath").is_some_and(Json::is_string)
            },
            |d, p| {
                let a: SourceArgs = payload(p)?;
                let (_, commit) = d.edit("Replace Image", |tx| set_source(tx, &a))?;
                Ok(commit.into())
            },
        );
        // Deletes a layer and its modifiers. rhizome drops every binding the layer was the
        // source of (`State::forget`), so no modifier keeps a dangling mask: the rule the
        // store's `pruneMaskState` applies, written once. A locked layer may go, as today.
        c.add(
            "layer.remove",
            |_| "Delete Layer".into(),
            |_, p| p.get("at").is_some_and(Json::is_string),
            |d, p| {
                let a: AtArgs = payload(p)?;
                let (_, commit) = d.edit("Delete Layer", |tx| {
                    let at = layer_at(tx, &a.at)?;
                    tx.remove(at)
                })?;
                Ok(commit.into())
            },
        );
        // Moves a layer to index `to` of the stack (index 0 = top) with the store's
        // `reorderNode` semantics: splice out, splice in. An index out of range is clamped to
        // the nearest end, so a stale or careless caller still moves the layer to the edge.
        // Compositing only, so a locked layer may move (lock-state-machine.md).
        c.add(
            "layer.reorder",
            |_| "Move Layer".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string) && p.get("to").is_some_and(Json::is_i64)
            },
            |d, p| {
                let a: ReorderArgs = payload(p)?;
                let (_, commit) = d.edit("Move Layer", |tx| {
                    let at = layer_at(tx, &a.at)?;
                    let mut stack = stack_of(tx);
                    let from = stack
                        .iter()
                        .position(|id| *id == at)
                        .ok_or_else(|| structural(format!("{} isn't in the stack", a.at)))?;
                    stack.remove(from);
                    let to = a.to.clamp(0, stack.len() as i64) as usize;
                    stack.insert(to, at);
                    tx.set_order("/layers", "stack", stack)
                })?;
                Ok(commit.into())
            },
        );
        // The copy of a layer, with the ids TypeScript picked (it selects the copy at once, so
        // this follows the store's own `duplicateNode`): `copyNode`'s rules, written once.
        c.add(
            "layer.duplicate",
            |_| "Duplicate Layer".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("id").is_some_and(Json::is_string)
                    && p.get("modifierIds").is_some_and(Json::is_array)
                    && p.get("maskIds").is_some_and(Json::is_array)
            },
            |d, p| {
                let a: DuplicateArgs = payload(p)?;
                let (_, commit) = d.edit("Duplicate Layer", |tx| duplicate_layer(tx, &a))?;
                Ok(commit.into())
            },
        );
        // A modifier on top of a layer's modifiers, with TypeScript's id (the caller uses it at
        // once). Every param is written explicitly, from the catalogue's default or from
        // `params` where the caller has a value of its own (Duplicate Modifier), so the row
        // names what it holds the way `layer.add`'s do. A locked layer refuses.
        c.add(
            "modifier.add",
            |_| "Add Modifier".into(),
            |_, p| {
                ["at", "id", "type"]
                    .iter()
                    .all(|k| p.get(k).is_some_and(Json::is_string))
            },
            |d, p| {
                let a: ModifierAddArgs = payload(p)?;
                let label = format!("Add {}", op_label(d.context(), &a.kind));
                let (_, commit) = d.edit(&label, |tx| add_modifier(tx, &a))?;
                Ok(commit.into())
            },
        );
        // Removes a modifier. Its mask binding goes with it; the layer that was the mask stays.
        c.add(
            "modifier.remove",
            |_| "Remove Modifier".into(),
            |_, p| p.get("at").is_some_and(Json::is_string),
            |d, p| {
                let a: AtArgs = payload(p)?;
                let (_, commit) = d.edit("Remove Modifier", |tx| {
                    let (m, layer) = modifier_at(tx, &a.at)?;
                    refuse_locked(tx, layer)?;
                    tx.remove(m)
                })?;
                Ok(commit.into())
            },
        );
        // Moves a modifier to index `to` of its layer's `modifiers` with the store's
        // `reorderModifier` semantics: splice out, splice in, clamped to the ends.
        c.add(
            "modifier.reorder",
            |_| "Move Modifier".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string) && p.get("to").is_some_and(Json::is_i64)
            },
            |d, p| {
                let a: ReorderArgs = payload(p)?;
                let (_, commit) = d.edit("Move Modifier", |tx| {
                    let (m, layer) = modifier_at(tx, &a.at)?;
                    refuse_locked(tx, layer)?;
                    let mut order = modifiers_of(tx, layer);
                    let from = order
                        .iter()
                        .position(|id| *id == m)
                        .ok_or_else(|| structural(format!("{} isn't in the order", a.at)))?;
                    order.remove(from);
                    let to = a.to.clamp(0, order.len() as i64) as usize;
                    order.insert(to, m);
                    tx.set_order(layer, "modifiers", order)
                })?;
                Ok(commit.into())
            },
        );
        // One modifier value: `enabled`, or an op param by its tree key (`params.<name>`; a bare
        // name could not tell a param called `enabled` from the switch). A value past a
        // param's max is kept (decision 53), a wrong type or one under its min is refused.
        c.add(
            "modifier.set",
            |_| "Set Modifier".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("key").is_some_and(Json::is_string)
                    && p.get("value").is_some()
            },
            |d, p| {
                let a: SetArgs = payload(p)?;
                let label = set_label(d, &a);
                let (_, commit) = d.edit(&label, |tx| {
                    let (m, layer) = modifier_at(tx, &a.at)?;
                    refuse_locked(tx, layer)?;
                    if a.key != "enabled" && !a.key.starts_with(PARAM_PREFIX) {
                        return Err(structural(format!("`{}` isn't a modifier value", a.key)));
                    }
                    set(tx, m, &a.key, &a.value)
                })?;
                Ok(commit.into())
            },
        );
        // Masks a modifier with a vector or text layer, replacing any mask it has. Sent again
        // with the same source and new numbers it is the edit of feather, expand or invert.
        // The mask keeps its `refId` while it lasts; a new one takes the modifier's own id.
        c.add(
            "mask.attach",
            |_| "Attach Mask".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("source").is_some_and(Json::is_string)
            },
            |d, p| {
                let a: AttachArgs = payload(p)?;
                let (_, commit) = d.edit("Attach Mask", |tx| {
                    let (m, layer) = modifier_at(tx, &a.at)?;
                    refuse_locked(tx, layer)?;
                    let source = layer_at(tx, &a.source)?;
                    let ref_id = mask_ref_id(tx, m);
                    let values = mask_binding(
                        ref_id,
                        [a.feather_px, a.expand],
                        a.invert,
                        a.space.as_deref(),
                        a.attach_transform.as_ref(),
                    );
                    tx.bind(m, On::slot("mask"), source, values)
                })?;
                Ok(commit.into())
            },
        );
        // Takes the mask off a modifier. The layer that was the mask stays.
        c.add(
            "mask.detach",
            |_| "Remove Mask".into(),
            |_, p| p.get("at").is_some_and(Json::is_string),
            |d, p| {
                let a: AtArgs = payload(p)?;
                let (_, commit) = d.edit("Remove Mask", |tx| {
                    let (m, layer) = modifier_at(tx, &a.at)?;
                    refuse_locked(tx, layer)?;
                    let (source, _) = mask_of(tx, m)
                        .ok_or_else(|| structural(format!("{} has no mask", a.at)))?;
                    tx.unbind(m, On::slot("mask"), source)
                })?;
                Ok(commit.into())
            },
        );
        // "Follows layer" (mask-follows-node.md): `node` snapshots the consumer's current
        // transform into `attachTransform`, `document` clears it and `space`. Already in
        // that space, nothing changes and nothing is a step.
        c.add(
            "mask.set_space",
            |_| "Mask Follows Layer".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("space").is_some_and(Json::is_string)
            },
            |d, p| {
                let a: SpaceArgs = payload(p)?;
                let (_, commit) = d.edit("Mask Follows Layer", |tx| set_mask_space(tx, &a))?;
                Ok(commit.into())
            },
        );
        // "Mask from Selection": a hidden vector layer on top of the stack, bound as the
        // modifier's mask pinned to the consumer's current transform, and the replace rule,
        // all one step. TypeScript picked the layer's id and built its paths.
        c.add(
            "mask.from_marquee",
            |_| "Mask from Selection".into(),
            |_, p| {
                ["at", "vectorId", "fillRule", "label"]
                    .iter()
                    .all(|k| p.get(k).is_some_and(Json::is_string))
                    && p.get("paths").is_some_and(Json::is_array)
            },
            |d, p| {
                let a: MarqueeArgs = payload(p)?;
                let (_, commit) = d.edit("Mask from Selection", |tx| mask_from_marquee(tx, &a))?;
                Ok(commit.into())
            },
        );
        // Replaces a vector layer's paths wholesale (path-editing.md): an anchor or handle drag,
        // an inserted or deleted anchor, a reordered path. One value, so inside a gesture the
        // webview's per-frame writes are latest-wins and the drag is one undo step. A locked
        // layer refuses (lock-state-machine.md); a malformed `paths` leaves the tree untouched.
        c.add(
            "vector.set_paths",
            |_| "Edit Path".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("paths").is_some_and(Json::is_array)
            },
            |d, p| {
                let a: PathsArgs = payload(p)?;
                let (_, commit) = d.edit("Edit Path", |tx| {
                    let at = vector_at(tx, &a.at)?;
                    set(tx, at, "paths", &a.paths)
                })?;
                Ok(commit.into())
            },
        );
        // A vector layer's fill rule: how overlapping paths rasterise. The same guards.
        c.add(
            "vector.set_fill_rule",
            |_| "Fill Rule".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("fillRule").is_some_and(Json::is_string)
            },
            |d, p| {
                let a: FillRuleArgs = payload(p)?;
                let (_, commit) = d.edit("Fill Rule", |tx| {
                    let at = vector_at(tx, &a.at)?;
                    set(tx, at, "fillRule", &json!(a.fill_rule))
                })?;
                Ok(commit.into())
            },
        );
        // Convert to Outlines: the text layer becomes a vector layer in place in the stack, in one
        // step. TypeScript shapes the text and sends the resulting paths and the new id (it
        // selects the new layer at once, so this follows the store's `convertTextToOutlines`).
        c.add(
            "text.to_outlines",
            |_| "Convert to Outlines".into(),
            |_, p| {
                ["at", "id"]
                    .iter()
                    .all(|k| p.get(k).is_some_and(Json::is_string))
                    && p.get("paths").is_some_and(Json::is_array)
            },
            |d, p| {
                let a: OutlinesArgs = payload(p)?;
                let (_, commit) = d.edit("Convert to Outlines", |tx| text_to_outlines(tx, &a))?;
                Ok(commit.into())
            },
        );
        // POM's other built-ins that write the tree would bypass the rules above, so they
        // refuse: Oblique's own commands replace them. Undo, redo, the file commands, copy and
        // export stay as POM has them.
        for id in NOT_MOVED {
            c.add(
                id,
                |_| "Not on rhizome yet".into(),
                |_, _| true,
                move |_, _| Err(structural(format!("`{id}` isn't on rhizome yet")).into()),
            );
        }
        c.add(
            "document.set_size",
            |_| "Document Size".into(),
            |_, p| p.get("size").is_some_and(Json::is_array),
            |d, p| {
                let a: SizeArgs = payload(p)?;
                let (_, commit) = d.edit("Document Size", |tx| {
                    set(tx, live(tx, "/document/document")?, "documentSize", &a.size)
                })?;
                Ok(commit.into())
            },
        );
        // The document background (background-colour.md, background-image.md): `null` clears
        // it, a colour is `{type: "color", color}`, an image `{type: "image", sourcePath,
        // sourceSize}`. Cleared is *unset*, not a stored null, so the scene reads back with no
        // `background` key, as the store has it. The decoded bitmap is the webview's.
        c.add(
            "document.set_background",
            |_| "Background".into(),
            |_, p| p.get("background").is_some(),
            |d, p| {
                let a: BackgroundArgs = payload(p)?;
                let background = background_value(&a.background)?;
                let (_, commit) = d.edit("Background", |tx| {
                    let doc = live(tx, DOCUMENT_AT)?;
                    match &background {
                        Some(b) => set(tx, doc, "background", b),
                        None => tx.reset(doc, "background"),
                    }
                })?;
                Ok(commit.into())
            },
        );
        // The composition note (composition-note.md). An empty string clears it, which unsets
        // the value so a saved file stays clean, as `setNote('')` removes the key.
        c.add(
            "document.set_note",
            |_| "Edit Note".into(),
            |_, p| p.get("note").is_some_and(Json::is_string),
            |d, p| {
                let a: NoteArgs = payload(p)?;
                let (_, commit) = d.edit("Edit Note", |tx| {
                    let doc = live(tx, DOCUMENT_AT)?;
                    if a.note.is_empty() {
                        tx.reset(doc, "note")
                    } else {
                        tx.set_value(doc, "note", Value::Text(a.note.clone()))
                    }
                })?;
                Ok(commit.into())
            },
        );
        // Lock or unlock a layer (lock-state-machine.md). The bake is the webview's: it cooks
        // the full-resolution bitmap first and sends this once that has succeeded. Any layer
        // kind can be locked, and unlocking a locked layer is exactly what this is for, so it
        // is the one layer command that does not refuse a locked layer. Already in that state,
        // nothing changes and nothing is a step.
        c.add(
            "layer.set_state",
            |_| "Lock Layer".into(),
            |_, p| {
                p.get("at").is_some_and(Json::is_string)
                    && p.get("state").is_some_and(Json::is_string)
            },
            |d, p| {
                let a: StateArgs = payload(p)?;
                let label = if a.state == "locked" {
                    "Lock Layer"
                } else {
                    "Unlock Layer"
                };
                let (_, commit) = d.edit(label, |tx| {
                    if !["active", "locked"].contains(&a.state.as_str()) {
                        return Err(structural(format!("`{}` isn't a layer state", a.state)));
                    }
                    let at = layer_at(tx, &a.at)?;
                    tx.set_value(at, "state", Value::Choice(a.state.clone()))
                })?;
                Ok(commit.into())
            },
        );
    }
}

const DOCUMENT_AT: &str = "/document/document";

/// A background as `document.set_background` takes it, in the one shape the store writes: a
/// colour has no image fields and an image no colour, so two equal backgrounds are equal trees.
/// `None` is "no background".
fn background_value(j: &Json) -> rhizome_core::Result<Option<Json>> {
    if j.is_null() {
        return Ok(None);
    }
    let o = j
        .as_object()
        .ok_or_else(|| structural("a background is null or a record"))?;
    let only = |keys: &[&str]| -> rhizome_core::Result<()> {
        match o.keys().find(|k| !keys.contains(&k.as_str())) {
            Some(k) => Err(structural(format!(
                "a {} background has no `{k}`",
                o["type"]
            ))),
            None => Ok(()),
        }
    };
    match o.get("type").and_then(Json::as_str) {
        Some("color") => {
            only(&["type", "color"])?;
            let color = o
                .get("color")
                .and_then(Json::as_str)
                .ok_or_else(|| structural("a colour background needs a `color`"))?;
            Ok(Some(json!({"type": "color", "color": color})))
        }
        Some("image") => {
            only(&["type", "sourcePath", "sourceSize"])?;
            let path = o
                .get("sourcePath")
                .and_then(Json::as_str)
                .ok_or_else(|| structural("an image background needs a `sourcePath`"))?;
            let size = o
                .get("sourceSize")
                .and_then(Json::as_array)
                .filter(|a| {
                    a.len() == 2 && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
                })
                .ok_or_else(|| structural("an image background needs a two-number `sourceSize`"))?;
            Ok(Some(
                json!({"type": "image", "sourcePath": path, "sourceSize": size}),
            ))
        }
        _ => Err(structural("a background is a `color` or an `image`")),
    }
}

#[derive(Deserialize)]
struct BackgroundArgs {
    background: Json,
}

#[derive(Deserialize)]
struct NoteArgs {
    note: String,
}

#[derive(Deserialize)]
struct StateArgs {
    at: String,
    state: String,
}

#[derive(Deserialize)]
struct NodeArgs {
    node: Json,
}

#[derive(Deserialize)]
struct SetArgs {
    at: String,
    key: String,
    value: Json,
}

#[derive(Deserialize)]
struct SetManyArgs {
    changes: Vec<SetArgs>,
}

#[derive(Deserialize)]
struct TextArgs {
    at: String,
    patch: Json,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceArgs {
    at: String,
    source_path: String,
    source_size: Option<[f64; 2]>,
}

#[derive(Deserialize)]
struct AtArgs {
    at: String,
}

#[derive(Deserialize)]
struct ReorderArgs {
    at: String,
    to: i64,
}

/// `modifier_ids[i]` and `mask_ids[i]` belong to the original's i-th modifier; a modifier
/// with no mask has `null` for its mask id.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateArgs {
    at: String,
    id: String,
    modifier_ids: Vec<String>,
    mask_ids: Vec<Option<String>>,
}

#[derive(Deserialize)]
struct ModifierAddArgs {
    at: String,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    /// Param values by param name that differ from the catalogue's defaults.
    #[serde(default)]
    params: serde_json::Map<String, Json>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachArgs {
    at: String,
    source: String,
    feather_px: f64,
    expand: f64,
    invert: bool,
    space: Option<String>,
    attach_transform: Option<Json>,
}

#[derive(Deserialize)]
struct SpaceArgs {
    at: String,
    space: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarqueeArgs {
    at: String,
    vector_id: String,
    paths: Json,
    fill_rule: String,
    label: String,
    feather_px: f64,
    expand: f64,
    invert: bool,
}

#[derive(Deserialize)]
struct PathsArgs {
    at: String,
    paths: Json,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FillRuleArgs {
    at: String,
    fill_rule: String,
}

#[derive(Deserialize)]
struct OutlinesArgs {
    at: String,
    id: String,
    paths: Json,
}

#[derive(Deserialize)]
struct SizeArgs {
    size: Json,
}

/// store.ts `textLabel`: the first non-blank line, trimmed and cut to 32 characters with a
/// trailing `…`, or `Text`.
pub fn text_label(content: &str) -> String {
    let Some(line) = content.split('\n').map(str::trim).find(|l| !l.is_empty()) else {
        return "Text".into();
    };
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > 32 {
        format!("{}…", chars[..32].iter().collect::<String>())
    } else {
        line.to_string()
    }
}

fn structural(m: impl Into<String>) -> rhizome_core::Error {
    rhizome_core::Error::Structural(m.into())
}

fn live(tx: &Edit<'_>, at: &str) -> rhizome_core::Result<NodeId> {
    tx.at(at)
        .map(|n| n.id())
        .ok_or_else(|| rhizome_core::Error::NotFound(at.into()))
}

fn refuse_locked(tx: &Edit<'_>, at: NodeId) -> rhizome_core::Result<()> {
    let n = tx.at(at).expect("live");
    if n.value("state") == Some(Value::Choice("locked".into())) {
        return Err(structural(format!("{} is locked", n.path())));
    }
    Ok(())
}

/// The layer at `at`: a pixel, vector or text node directly under `/layers`. The layer
/// commands refuse anything else, so none of them reaches a modifier (story 4's) or the document.
fn layer_at(tx: &Edit<'_>, at: &str) -> rhizome_core::Result<NodeId> {
    let id = live(tx, at)?;
    let n = tx.at(id).expect("live");
    let under_layers = n
        .parent()
        .is_some_and(|p| p.path().to_string() == "/layers");
    if !under_layers || !["pixel", "vector", "text"].contains(&n.type_name()) {
        return Err(structural(format!("{at} isn't a layer")));
    }
    Ok(id)
}

/// A `Transform2D` (src/scene/types.ts): `(x, y)` is the translation of the node's source box,
/// which scales and rotates about its own centre.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    x: f64,
    y: f64,
    scale_x: f64,
    scale_y: f64,
    rotation: f64,
}

impl Placement {
    fn from_json(j: &Json) -> Option<Placement> {
        let f = |k: &str| j.get(k).and_then(Json::as_f64);
        Some(Placement {
            x: f("x")?,
            y: f("y")?,
            scale_x: f("scaleX")?,
            scale_y: f("scaleY")?,
            rotation: f("rotation")?,
        })
    }

    fn to_json(self) -> Json {
        json!({
            "x": self.x, "y": self.y,
            "scaleX": self.scale_x, "scaleY": self.scale_y,
            "rotation": self.rotation,
        })
    }
}

/// `-1` for a negative scale, else `1` (a zero scale reads as unflipped).
fn sign_of(n: f64) -> f64 {
    if n < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// The transform that makes a new source of `new_size` fit uniformly inside the old footprint
/// (`old_size` scaled by `old`), centred on the old centre. Rotation and flip signs survive. A
/// collapsed old footprint (a zero scale) has no box to fit: the scale is kept and only the
/// centre is preserved. Ported from `fitReplacedTransform` (src/scene/sourceFit.ts).
fn fit_replaced_transform(old: Placement, old_size: [f64; 2], new_size: [f64; 2]) -> Placement {
    let [w0, h0] = old_size;
    let [w1, h1] = new_size;
    let footprint_w = w0 * old.scale_x.abs();
    let footprint_h = h0 * old.scale_y.abs();
    let fits = footprint_w > 0.0 && footprint_h > 0.0 && w1 > 0.0 && h1 > 0.0;
    let s = fits.then(|| (footprint_w / w1).min(footprint_h / h1));
    Placement {
        x: old.x + w0 / 2.0 - w1 / 2.0,
        y: old.y + h0 / 2.0 - h1 / 2.0,
        scale_x: s.map_or(old.scale_x, |s| s * sign_of(old.scale_x)),
        scale_y: s.map_or(old.scale_y, |s| s * sign_of(old.scale_y)),
        rotation: old.rotation,
    }
}

/// A node-space mask's `attachTransform` after its consumer's source was replaced: the
/// snapshot's rotation and centre are kept and each axis scales by the node's own scale ratio,
/// so the mask covers the same canvas region as before. Ported from `refitAttachTransform`
/// (src/scene/sourceFit.ts), where the algebra is derived.
fn refit_attach_transform(
    attach: Placement,
    old_node: Placement,
    new_node: Placement,
    old_size: [f64; 2],
    new_size: [f64; 2],
) -> Placement {
    let ratio = |old: f64, new: f64| if old == 0.0 { 1.0 } else { new / old };
    Placement {
        x: attach.x + old_size[0] / 2.0 - new_size[0] / 2.0,
        y: attach.y + old_size[1] / 2.0 - new_size[1] / 2.0,
        scale_x: attach.scale_x * ratio(old_node.scale_x, new_node.scale_x),
        scale_y: attach.scale_y * ratio(old_node.scale_y, new_node.scale_y),
        rotation: attach.rotation,
    }
}

/// The keys a modifier mask binding carries (`mask_values`).
const MASK_KEYS: [&str; 6] = [
    "refId",
    "featherPx",
    "expand",
    "invert",
    "space",
    "attachTransform",
];

/// `layer.set_source`: the path always; with a different size, the fit and the mask refits.
fn set_source(tx: &mut Edit<'_>, a: &SourceArgs) -> rhizome_core::Result<()> {
    let at = live(tx, &a.at)?;
    if tx.at(at).map(|n| n.type_name() != "pixel").unwrap_or(true) {
        return Err(structural(format!("{} isn't a pixel layer", a.at)));
    }
    refuse_locked(tx, at)?;

    let n = tx.at(at).expect("live");
    let old_size = match n.value("sourceSize") {
        Some(Value::Vec2(v)) => v,
        _ => [0.0, 0.0],
    };
    // an unset transform reads as its defaults: the identity
    let pair = |key: &str, default: [f64; 2]| match n.value(key) {
        Some(Value::Vec2(v)) => v,
        _ => default,
    };
    let [x, y] = pair("transform2d.position", [0.0, 0.0]);
    let [scale_x, scale_y] = pair("transform2d.scale", [1.0, 1.0]);
    let rotation = match n.value("transform2d.rotation") {
        Some(Value::Float(r)) => r,
        _ => 0.0,
    };
    let old = Placement {
        x,
        y,
        scale_x,
        scale_y,
        rotation,
    };

    // Node-space masks this layer consumes: each modifier's mask binding that follows the
    // layer and holds its snapshot. Collected first, written after.
    struct Refit {
        modifier: NodeId,
        source: NodeId,
        values: Vec<(&'static str, Value)>,
        attach: Placement,
    }
    let mut refits = vec![];
    for modifier in n.order("modifiers") {
        for b in modifier.bindings() {
            if *b.on != On::slot("mask") {
                continue;
            }
            if b.value("space") != Some(Value::Shaped(json!("node"))) {
                continue;
            }
            let Some(Value::Shaped(j)) = b.value("attachTransform") else {
                continue;
            };
            let Some(attach) = Placement::from_json(&j) else {
                continue;
            };
            refits.push(Refit {
                modifier: modifier.id(),
                source: b.source.id(),
                values: MASK_KEYS
                    .iter()
                    .filter_map(|k| Some((*k, b.value(k)?)))
                    .collect(),
                attach,
            });
        }
    }

    tx.set_ref(at, "source", Ref::file(&a.source_path))?;
    let Some(new_size) = a.source_size.filter(|s| *s != old_size) else {
        return Ok(());
    };
    let new = fit_replaced_transform(old, old_size, new_size);
    tx.set_value(at, "sourceSize", Value::Vec2(new_size))?;
    tx.set_value(at, "transform2d.position", Value::Vec2([new.x, new.y]))?;
    tx.set_value(
        at,
        "transform2d.scale",
        Value::Vec2([new.scale_x, new.scale_y]),
    )?;
    tx.set_value(at, "transform2d.rotation", Value::Float(new.rotation))?;
    for r in refits {
        let attach = refit_attach_transform(r.attach, old, new, old_size, new_size);
        let values = r.values.into_iter().map(|(k, v)| {
            if k == "attachTransform" {
                (k, Value::Shaped(attach.to_json()))
            } else {
                (k, v)
            }
        });
        tx.bind(r.modifier, On::slot("mask"), r.source, values)?;
    }
    Ok(())
}

/// What a layer's copy takes from the original besides its own identity.
const NOT_COPIED: [&str; 5] = [
    "label",
    "state",
    "transform2d.position",
    "transform2d.scale",
    "transform2d.rotation",
];

/// A modifier of the original, read out before the copy is written.
struct ModifierCopy {
    type_name: String,
    id: String,
    values: Vec<(String, Value)>,
    /// The mask binding: its source, and its values with the new `refId` already in.
    mask: Option<(NodeId, Vec<(&'static str, Value)>)>,
}

/// `layer.duplicate`: `copyNode` (src/scene/store.ts) in the tree. Label `"<label> copy"`,
/// active and never locked, the transform offset by `DUPLICATE_OFFSET_PX` (an unmoved original
/// reads as the identity), modifiers copied under fresh ids, each mask binding copied onto the
/// copy's modifier with the same source and values under a fresh `refId`, and the copy
/// inserted directly above the original.
fn duplicate_layer(tx: &mut Edit<'_>, a: &DuplicateArgs) -> rhizome_core::Result<()> {
    let src = layer_at(tx, &a.at)?;
    let stack = stack_of(tx);
    let index = stack
        .iter()
        .position(|id| *id == src)
        .ok_or_else(|| structural(format!("{} isn't in the stack", a.at)))?;

    // Everything is read first and written after: `tx.at` borrows the tree.
    let n = tx.at(src).expect("live");
    let modifiers = n.order("modifiers");
    if a.modifier_ids.len() != modifiers.len() || a.mask_ids.len() != modifiers.len() {
        return Err(structural(format!(
            "{} has {} modifiers, but {} ids and {} mask ids came",
            a.at,
            modifiers.len(),
            a.modifier_ids.len(),
            a.mask_ids.len()
        )));
    }
    let kind = n.type_name().to_string();
    let values: Vec<(String, Value)> = n
        .stored_values()
        .filter(|(k, _)| !NOT_COPIED.contains(k))
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    let refs: Vec<(String, Ref)> = n
        .node_type()
        .map(|t| t.refs().to_vec())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|k| Some((k.clone(), n.reference(&k)?.clone())))
        .collect();
    let label = match n.value("label") {
        Some(Value::Text(s)) => s,
        _ => String::new(),
    };
    let pair = |key: &str, default: [f64; 2]| match n.value(key) {
        Some(Value::Vec2(v)) => v,
        _ => default,
    };
    let [x, y] = pair("transform2d.position", [0.0, 0.0]);
    let scale = pair("transform2d.scale", [1.0, 1.0]);
    let rotation = match n.value("transform2d.rotation") {
        Some(Value::Float(r)) => r,
        _ => 0.0,
    };
    let mut copies = vec![];
    for (i, m) in modifiers.iter().enumerate() {
        let mask = match m.bindings().into_iter().find(|b| *b.on == On::slot("mask")) {
            None => None,
            Some(b) => {
                let ref_id = a.mask_ids[i].clone().ok_or_else(|| {
                    structural(format!(
                        "{}: a masked modifier came with no mask id",
                        m.path()
                    ))
                })?;
                let values = MASK_KEYS
                    .iter()
                    .filter_map(|k| {
                        let v = if *k == "refId" {
                            Value::Text(ref_id.clone())
                        } else {
                            b.value(k)?
                        };
                        Some((*k, v))
                    })
                    .collect();
                Some((b.source.id(), values))
            }
        };
        copies.push(ModifierCopy {
            type_name: m.type_name().to_string(),
            id: a.modifier_ids[i].clone(),
            values: m
                .stored_values()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
            mask,
        });
    }

    let copy = tx.add("/layers", &kind, &a.id)?;
    for (k, v) in values {
        tx.set_value(copy, &k, v)?;
    }
    for (k, r) in refs {
        tx.set_ref(copy, k.as_str(), r)?;
    }
    tx.set_value(copy, "label", Value::Text(format!("{label} copy")))?;
    tx.set_value(copy, "state", Value::Choice("active".into()))?;
    let offset = DUPLICATE_OFFSET_PX;
    tx.set_value(
        copy,
        "transform2d.position",
        Value::Vec2([x + offset, y + offset]),
    )?;
    tx.set_value(copy, "transform2d.scale", Value::Vec2(scale))?;
    tx.set_value(copy, "transform2d.rotation", Value::Float(rotation))?;

    let mut order = vec![];
    for m in copies {
        let node = tx.add(copy, &m.type_name, &m.id)?;
        order.push(node);
        for (k, v) in m.values {
            tx.set_value(node, &k, v)?;
        }
        if let Some((source, values)) = m.mask {
            tx.bind(node, On::slot("mask"), source, values)?;
        }
    }
    if !order.is_empty() {
        tx.set_order(copy, "modifiers", order)?;
    }
    let mut stack = stack;
    stack.insert(index, copy);
    tx.set_order("/layers", "stack", stack)
}

// ---- modifiers and masks ----

/// The panel label of an op, for undo step names: the catalogue's, else its name made
/// readable (`gaussian_blur` -> `Gaussian blur`).
fn op_label(cx: &Catalogue, name: &str) -> String {
    let label =
        cx.0.iter()
            .find(|o| o.name == name)
            .and_then(|o| o.label.clone());
    label.unwrap_or_else(|| readable(name))
}

fn readable(name: &str) -> String {
    let spaced = name.replace('_', " ");
    let mut chars = spaced.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

/// The undo step name of a `modifier.set`: "Enable Modifier", "Disable Modifier" or
/// "Set <param label>".
fn set_label(d: &rhizome_pom::Document<Oblique>, a: &SetArgs) -> String {
    if a.key == "enabled" {
        let on = a.value.as_bool().unwrap_or(true);
        return if on {
            "Enable Modifier"
        } else {
            "Disable Modifier"
        }
        .into();
    }
    let Some(param) = a.key.strip_prefix(PARAM_PREFIX) else {
        return "Set Modifier".into();
    };
    let op = d
        .tree()
        .at(a.at.as_str())
        .map(|n| n.type_name().trim_start_matches("op.").to_string());
    let label = op.and_then(|op| {
        d.context()
            .0
            .iter()
            .find(|o| o.name == op)
            .and_then(|o| o.params.iter().find(|p| p.name == param))
            .and_then(|p| p.label.clone())
    });
    format!("Set {}", label.unwrap_or_else(|| readable(param)))
}

/// The modifier at `at` and the layer it belongs to. The modifier commands refuse anything
/// else, so none of them reaches a layer (story 3's) or the document.
fn modifier_at(tx: &Edit<'_>, at: &str) -> rhizome_core::Result<(NodeId, NodeId)> {
    let id = live(tx, at)?;
    let n = tx.at(id).expect("live");
    let layer = n.parent().filter(|p| {
        ["pixel", "vector", "text"].contains(&p.type_name())
            && p.parent()
                .is_some_and(|g| g.path().to_string() == "/layers")
    });
    match layer {
        Some(l) if n.type_name().starts_with("op.") => Ok((id, l.id())),
        _ => Err(structural(format!("{at} isn't a modifier"))),
    }
}

fn modifiers_of(tx: &Edit<'_>, layer: NodeId) -> Vec<NodeId> {
    tx.at(layer)
        .map(|l| l.order("modifiers").iter().map(|n| n.id()).collect())
        .unwrap_or_default()
}

/// `modifier.add`: the modifier last in its layer's order, every param written.
fn add_modifier(tx: &mut Edit<'_>, a: &ModifierAddArgs) -> rhizome_core::Result<()> {
    let layer = layer_at(tx, &a.at)?;
    refuse_locked(tx, layer)?;
    let m = tx.add(layer, &op_type(&a.kind), &a.id)?;
    let defaults: Vec<(String, Value)> = tx
        .at(m)
        .and_then(|n| n.node_type().map(|t| t.values().to_vec()))
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.key.starts_with(PARAM_PREFIX))
        .map(|s| (s.key, s.default))
        .collect();
    tx.set_value(m, "enabled", Value::Bool(true))?;
    for (key, default) in defaults {
        tx.set_value(m, &key, default)?;
    }
    for (name, v) in &a.params {
        set(tx, m, &param_key(name), v)?;
    }
    let mut order = modifiers_of(tx, layer);
    order.push(m);
    tx.set_order(layer, "modifiers", order)
}

/// A modifier's mask: its source layer and the `refId` it carries, if it has one.
fn mask_of(tx: &Edit<'_>, modifier: NodeId) -> Option<(NodeId, Option<String>)> {
    let n = tx.at(modifier)?;
    let b = n
        .bindings()
        .into_iter()
        .find(|b| *b.on == On::slot("mask"))?;
    let ref_id = match b.value("refId") {
        Some(Value::Text(s)) if !s.is_empty() => Some(s),
        _ => None,
    };
    Some((b.source.id(), ref_id))
}

/// The `refId` a mask on `modifier` goes by: the one it has, else the modifier's own id, which
/// no other mask can share. The store picks the same (`setModifierVectorMask`), so the two
/// agree on an id neither was told.
fn mask_ref_id(tx: &Edit<'_>, modifier: NodeId) -> String {
    mask_of(tx, modifier)
        .and_then(|(_, r)| r)
        .unwrap_or_else(|| tx.at(modifier).expect("live").name().to_string())
}

/// The values a mask binding carries (`mask_values`). `space` and `attachTransform` are left
/// out for a document-space mask, which reads as unset.
fn mask_binding(
    ref_id: String,
    [feather_px, expand]: [f64; 2],
    invert: bool,
    space: Option<&str>,
    attach: Option<&Json>,
) -> Vec<(&'static str, Value)> {
    let mut values = vec![
        ("refId", Value::Text(ref_id)),
        ("featherPx", Value::Float(feather_px)),
        ("expand", Value::Float(expand)),
        ("invert", Value::Bool(invert)),
    ];
    if let Some(space) = space {
        values.push(("space", Value::Shaped(json!(space))));
    }
    if let Some(attach) = attach.filter(|a| !a.is_null()) {
        values.push(("attachTransform", Value::Shaped(attach.clone())));
    }
    values
}

/// A layer's transform; an unmoved layer reads as the identity.
fn placement_of(tx: &Edit<'_>, layer: NodeId) -> Placement {
    let n = tx.at(layer).expect("live");
    let pair = |key: &str, default: [f64; 2]| match n.value(key) {
        Some(Value::Vec2(v)) => v,
        _ => default,
    };
    let [x, y] = pair("transform2d.position", [0.0, 0.0]);
    let [scale_x, scale_y] = pair("transform2d.scale", [1.0, 1.0]);
    let rotation = match n.value("transform2d.rotation") {
        Some(Value::Float(r)) => r,
        _ => 0.0,
    };
    Placement {
        x,
        y,
        scale_x,
        scale_y,
        rotation,
    }
}

/// `mask.set_space`.
fn set_mask_space(tx: &mut Edit<'_>, a: &SpaceArgs) -> rhizome_core::Result<()> {
    let (m, layer) = modifier_at(tx, &a.at)?;
    refuse_locked(tx, layer)?;
    if !["document", "node"].contains(&a.space.as_str()) {
        return Err(structural(format!("`{}` isn't a mask space", a.space)));
    }
    let n = tx.at(m).expect("live");
    let b = n
        .bindings()
        .into_iter()
        .find(|b| *b.on == On::slot("mask"))
        .ok_or_else(|| structural(format!("{} has no mask", a.at)))?;
    let following = b.value("space") == Some(Value::Shaped(json!("node")));
    if following == (a.space == "node") {
        return Ok(());
    }
    let number = |k: &str| match b.value(k) {
        Some(Value::Float(f)) => f,
        _ => 0.0,
    };
    let (source, feather_px, expand) = (b.source.id(), number("featherPx"), number("expand"));
    let invert = b.value("invert") == Some(Value::Bool(true));
    let ref_id = mask_ref_id(tx, m);
    let attach = (a.space == "node").then(|| placement_of(tx, layer).to_json());
    let values = mask_binding(
        ref_id,
        [feather_px, expand],
        invert,
        attach.as_ref().map(|_| "node"),
        attach.as_ref(),
    );
    tx.bind(m, On::slot("mask"), source, values)
}

/// `mask.from_marquee`.
fn mask_from_marquee(tx: &mut Edit<'_>, a: &MarqueeArgs) -> rhizome_core::Result<()> {
    let (m, layer) = modifier_at(tx, &a.at)?;
    refuse_locked(tx, layer)?;
    // what the mask pointed at before, read first: the replace rule needs it
    let previous = mask_of(tx, m).map(|(source, _)| source);
    let ref_id = mask_ref_id(tx, m);
    let consumer = placement_of(tx, layer);

    let v = tx.add("/layers", "vector", &a.vector_id)?;
    set(tx, v, "label", &json!(a.label))?;
    set(tx, v, "visible", &json!(false))?;
    set(tx, v, "paths", &a.paths)?;
    set(tx, v, "fillRule", &json!(a.fill_rule))?;
    let mut stack = stack_of(tx);
    stack.retain(|id| *id != v);
    stack.insert(0, v);
    tx.set_order("/layers", "stack", stack)?;

    // a selection made on the image belongs to the image (mask-follows-node.md)
    let values = mask_binding(
        ref_id,
        [a.feather_px, a.expand],
        a.invert,
        Some("node"),
        Some(&consumer.to_json()),
    );
    tx.bind(m, On::slot("mask"), v, values)?;

    // The replace rule: the previous source goes when it is a selection of ours (not a
    // layer the user made) and nothing else uses it.
    if let Some(prev) = previous.filter(|p| *p != v && *p != layer) {
        let n = tx.at(prev).expect("live");
        let ours = matches!(n.value("label"), Some(Value::Text(l)) if l.starts_with("Selection ("));
        if ours && n.bound_to().is_empty() {
            tx.remove(prev)?;
        }
    }
    Ok(())
}

// ---- vectors and text ----

/// The vector layer at `at`, unlocked: what the path commands write to.
fn vector_at(tx: &Edit<'_>, at: &str) -> rhizome_core::Result<NodeId> {
    let id = layer_at(tx, at)?;
    if tx.at(id).expect("live").type_name() != "vector" {
        return Err(structural(format!("{at} isn't a vector layer")));
    }
    refuse_locked(tx, id)?;
    Ok(id)
}

/// What Convert to Outlines carries from the text layer to the vector layer, besides the
/// modifiers: the compositing props and the transform. Read as stored, so a text layer that was
/// never moved gives a vector layer that was never moved (the store carries `transform2d` only
/// when it is set). The 3D `transform` and `cameraId` are not carried, as in the store.
const OUTLINE_CARRIED: [&str; 8] = [
    "label",
    "output",
    "visible",
    "blendMode",
    "opacity",
    "transform2d.position",
    "transform2d.scale",
    "transform2d.rotation",
];

/// `text.to_outlines`: `convertTextToOutlines` (src/scene/store.ts) in the tree. The vector
/// layer takes the text layer's place in the stack. Its modifiers are moved over, not copied,
/// so they keep their ids and their own mask bindings (a binding is stored on its target). Every
/// binding sourced from the text layer is re-bound to the vector layer with the same values;
/// bindings are keyed by the source's node id, so removing the text layer would otherwise drop
/// them.
fn text_to_outlines(tx: &mut Edit<'_>, a: &OutlinesArgs) -> rhizome_core::Result<()> {
    let text = layer_at(tx, &a.at)?;
    if tx.at(text).expect("live").type_name() != "text" {
        return Err(structural(format!("{} isn't a text layer", a.at)));
    }
    refuse_locked(tx, text)?;
    let stack = stack_of(tx);
    let index = stack
        .iter()
        .position(|id| *id == text)
        .ok_or_else(|| structural(format!("{} isn't in the stack", a.at)))?;

    // Everything is read first and written after: `tx.at` borrows the tree.
    let n = tx.at(text).expect("live");
    let carried: Vec<(String, Value)> = n
        .stored_values()
        .filter(|(k, _)| OUTLINE_CARRIED.contains(k))
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    let modifiers: Vec<NodeId> = n.order("modifiers").iter().map(|m| m.id()).collect();
    // the bindings this layer is the source of: (target, slot or key, values)
    let mut repointed = vec![];
    for b in n.bound_to() {
        let values: Vec<(&'static str, Value)> = MASK_KEYS
            .iter()
            .filter_map(|k| Some((*k, b.value(k)?)))
            .collect();
        repointed.push((b.target.id(), b.on.clone(), values));
    }

    let v = tx.add("/layers", "vector", &a.id)?;
    for (k, value) in carried {
        tx.set_value(v, &k, value)?;
    }
    tx.set_value(v, "state", Value::Choice("active".into()))?;
    set(tx, v, "paths", &a.paths)?;
    set(tx, v, "fillRule", &json!("nonzero"))?;

    for m in &modifiers {
        tx.move_to(*m, v)?;
    }
    if !modifiers.is_empty() {
        tx.set_order(v, "modifiers", modifiers)?;
    }
    for (target, on, values) in repointed {
        tx.unbind(target, on.clone(), text)?;
        tx.bind(target, on, v, values)?;
    }

    let mut stack = stack;
    stack[index] = v;
    tx.set_order("/layers", "stack", stack)?;
    tx.remove(text)
}

fn stack_of(tx: &Edit<'_>) -> Vec<NodeId> {
    tx.at("/layers")
        .map(|l| l.order("stack").iter().map(|n| n.id()).collect())
        .unwrap_or_default()
}

fn set(tx: &mut Edit<'_>, at: NodeId, key: &str, j: &Json) -> rhizome_core::Result<()> {
    let n = tx.at(at).expect("live");
    let kind = n
        .node_type()
        .and_then(|t| t.values().iter().find(|s| s.key == key).map(|s| s.kind))
        .ok_or_else(|| structural(format!("{}: no value `{key}`", n.path())))?;
    let v = Value::from_json(kind, j)
        .ok_or_else(|| structural(format!("{}: `{key}` = {j} doesn't fit", n.path())))?;
    tx.set_value(at, key, v)
}

/// Writes an Oblique `SceneNode` (JSON) as a layer under `/layers`, named by its id, with its
/// modifiers.
pub fn add_layer(tx: &mut Edit<'_>, n: &Json) -> rhizome_core::Result<NodeId> {
    let id = n["id"]
        .as_str()
        .ok_or_else(|| structural("a layer without an id"))?;
    let kind = n["type"].as_str().unwrap_or("");
    if !["pixel", "vector", "text"].contains(&kind) {
        return Err(structural(format!(
            "{id}: no `{kind}` layers on rhizome yet"
        )));
    }
    let at = tx.add("/layers", kind, id)?;
    for key in [
        "label",
        "state",
        "output",
        "visible",
        "blendMode",
        "opacity",
    ] {
        set(tx, at, key, &n[key])?;
    }
    if let Some(t) = n.get("transform2d").filter(|t| t.is_object()) {
        set(tx, at, "transform2d.position", &json!([t["x"], t["y"]]))?;
        set(
            tx,
            at,
            "transform2d.scale",
            &json!([t["scaleX"], t["scaleY"]]),
        )?;
        set(tx, at, "transform2d.rotation", &t["rotation"])?;
    }
    if let Some(m) = n.get("transform").filter(|m| m.is_array()) {
        set(tx, at, "transform", m)?;
    }
    match kind {
        "pixel" => {
            let path = n["sourcePath"].as_str().unwrap_or("");
            tx.set_ref(at, "source", Ref::file(path))?;
            set(tx, at, "sourceSize", &n["sourceSize"])?;
        }
        "vector" => {
            set(tx, at, "paths", &n["paths"])?;
            set(tx, at, "fillRule", &n["fillRule"])?;
        }
        _ => {
            for key in TEXT_KEYS {
                set(tx, at, key, &n[*key])?;
            }
        }
    }
    let mut order = vec![];
    for m in n["modifiers"].as_array().into_iter().flatten() {
        let mid = m["id"]
            .as_str()
            .ok_or_else(|| structural("a modifier without an id"))?;
        let op = m["type"].as_str().unwrap_or("");
        let mat = tx.add(at, &op_type(op), mid)?;
        order.push(mat);
        set(tx, mat, "enabled", &m["enabled"])?;
        for (k, v) in m["params"].as_object().into_iter().flatten() {
            set(tx, mat, &param_key(k), v)?;
        }
    }
    if !order.is_empty() {
        tx.set_order(at, "modifiers", order)?;
    }
    Ok(at)
}

/// Prints a message from the webview in the terminal running the app (reconcile
/// differences, refusals), where it stays readable.
#[tauri::command]
pub fn document_log(message: String) {
    eprintln!("[document] {message}");
}

/// Fills the document host once the webview has the op catalogue, and manages the transport's
/// host over it. The host itself is managed at launch (`lib.rs`), because app-kit asks for it
/// before there is a document; a reloaded webview finds it already filled.
///
/// An `open` the host held until now (a restored document, a Finder open) is applied last, so
/// it emits to a webview whose transport state exists. If it fails the document stays
/// untitled: the failure goes to the webview as an app-kit note (`apply_held`) and
/// `document_init` still succeeds, or the webview would never get a document at all.
///
/// Answers whether it opened a held file. The webview needs to know, because the
/// `document-opened` event for it and this command's reply travel by different routes and may
/// arrive in either order: it keeps the store as it is until that event has been handled.
#[tauri::command]
pub fn document_init<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ops: Vec<Op>,
) -> Result<bool, String> {
    use tauri::Manager;
    let host = app.state::<DocumentHost>();
    if host.is_ready() {
        return Ok(false);
    }
    let pom =
        Pom::<Oblique>::files_in(Arc::new(Catalogue(ops))).map_err(|e: Error| e.to_string())?;
    let Some(transport) = host.init(pom) else {
        return Ok(false);
    };
    app.manage(transport);
    // an error is already a note for the webview; the document stays untitled
    Ok(host.apply_held(&app).unwrap_or(false))
}
