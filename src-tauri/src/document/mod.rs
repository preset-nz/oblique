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

use rhizome_core::{Edit, NodeId, NodeType, Origin, Ref, Shape, Value, ValueSpec};
use rhizome_pom::{payload, Commands, Error, Kinds, ObjectModel, Pom};
use serde::Deserialize;
use serde_json::{json, Value as Json};

mod host;
#[cfg(test)]
mod tests;

pub use host::DocumentHost;

pub const EXTENSION: &str = "oblique";

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

/// POM built-in commands that write the tree and that Oblique has not moved yet.
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
    pub params: Vec<OpParam>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct OpParam {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub default: Json,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(default)]
    pub choices: Vec<String>,
}

/// The op catalogue: what modifier kinds exist (rhizome decision 52).
#[derive(Default)]
pub struct Catalogue(pub Vec<Op>);

pub struct Oblique;

/// A modifier's node type: `op.<name>`.
pub fn op_type(name: &str) -> String {
    format!("op.{name}")
}

/// An op param's value key on a modifier: `params.<name>`.
pub fn param_key(name: &str) -> String {
    format!("params.{name}")
}

fn param_spec(p: &OpParam) -> Option<ValueSpec> {
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
        .in_categories(&["layers"])
        .text("label", "")
        .choice("state", &["active", "locked"], "active")
        .choice("output", &["image", "mask", "transform", "data"], "image")
        .bool("visible", true)
        .choice("blendMode", BLEND, "normal")
        .float("opacity", 0.0..=1.0, 1.0)
        // transform2d is optional in Oblique (identity when absent): split so a drag writes
        // one key, and "set" tells present from absent
        .vec2("transform2d.position", [0.0, 0.0])
        .vec2("transform2d.scale", [1.0, 1.0])
        .float_unbounded("transform2d.rotation", 0.0)
        .floats("transform", &[0.0; 16])
        .reference("cameraId")
}

/// The values a modifier mask carries (`VectorMaskRef` less its node).
fn mask_values() -> Vec<ValueSpec> {
    vec![
        ValueSpec::text("refId", ""),
        ValueSpec::float_unbounded("featherPx", 0.0),
        ValueSpec::float_unbounded("expand", 0.0),
        ValueSpec::bool("invert", false),
        ValueSpec::shaped(
            "space",
            Shape::optional(Shape::choice(&["document", "node"])),
        ),
        ValueSpec::shaped("attachTransform", Shape::optional(transform2d())),
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
                .in_categories(&["document"])
                .text("sceneId", "")
                .vec2("documentSize", [0.0, 0.0])
                .choice("resolution", &["draft", "working", "baked"], "working")
                .text("note", "")
                .shaped(
                    "background",
                    Shape::optional(Shape::record([
                        ("type", Shape::choice(&["color", "image"])),
                        ("color", Shape::optional(Shape::Text)),
                        ("sourcePath", Shape::optional(Shape::Text)),
                        ("sourceSize", Shape::optional(Shape::Vec2)),
                    ])),
                )
                .reference("defaultCameraId"),
        )
        .not_deletable()
        .not_duplicable()
        .max_per_parent(1);

        k.kind(
            layer("pixel")
                .reference("source")
                .vec2("sourceSize", [0.0, 0.0]),
        );
        k.kind(
            layer("vector")
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
                .choice("fillRule", &["nonzero", "evenodd"], "nonzero")
                .bindable(mask_values()),
        );
        k.kind(
            layer("text")
                .text("content", "")
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
                .float_unbounded("fontSize", 72.0)
                .float_unbounded("tracking", 0.0)
                .float("kerning", 0.0..=200.0, 100.0)
                .float_unbounded("lineHeight", 1.2)
                .choice("align", &["left", "center", "right"], "left")
                .shaped("fill", Shape::optional(Shape::Text))
                .shaped(
                    "stroke",
                    Shape::optional(Shape::record([
                        ("color", Shape::Text),
                        ("width", Shape::Float),
                    ])),
                )
                .shaped("position", point())
                .bindable(mask_values()),
        );
        for op in &ops.0 {
            let mut t = NodeType::new(&op_type(&op.name))
                .in_categories(&["layers"])
                .bool("enabled", true)
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
        // POM's other built-ins that write the tree would bypass the rules above, so they
        // refuse until the story that moves them (Epic 21 stories 3-6). Undo, redo, the file
        // commands, copy and export stay as POM has them.
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
    }
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

/// Makes the document host once the webview has the op catalogue, and manages it. A reloaded
/// webview finds it already there.
#[tauri::command]
pub fn document_init<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ops: Vec<Op>,
) -> Result<(), String> {
    use tauri::Manager;
    if app.try_state::<rhizome_pom_tauri::PomHost>().is_some() {
        return Ok(());
    }
    let pom =
        Pom::<Oblique>::files_in(Arc::new(Catalogue(ops))).map_err(|e: Error| e.to_string())?;
    let (document, transport) = DocumentHost::new(pom);
    app.manage(transport);
    app.manage(document);
    Ok(())
}
