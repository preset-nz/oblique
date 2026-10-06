//! The object model's contracts, with no window: every write is a command, one undo step
//! each, and the domain rules (locks, labels, soft max) hold however the webview behaves.

use std::sync::Arc;

use rhizome_core::{IdSource, Value};
use rhizome_pom::{Document, Host, MemoryStore, Outcome, Pom};
use serde_json::{json, Value as Json};

use super::{Catalogue, DocumentHost, Oblique, Op, OpParam};

fn param(name: &str, kind: &str, default: Json, min: Option<f64>, max: Option<f64>) -> OpParam {
    OpParam {
        name: name.into(),
        kind: kind.into(),
        default,
        min,
        max,
        choices: if kind == "enum" {
            vec!["soft".into(), "hard".into()]
        } else {
            vec![]
        },
    }
}

/// What `list_ops` might report, with each param kind that has a kind of value in rhizome.
fn catalogue() -> Arc<Catalogue> {
    Arc::new(Catalogue(vec![Op {
        name: "blur".into(),
        params: vec![
            param("radius", "float", json!(5.0), Some(0.0), Some(100.0)),
            param("steps", "int", json!(3), Some(1.0), Some(10.0)),
            param("gain", "float", json!(1.0), None, None),
            param("mode", "enum", json!("soft"), None, None),
            param("tint", "color", json!("#ff0000"), None, None),
            param("on", "bool", json!(true), None, None),
        ],
    }]))
}

fn doc() -> Document<Oblique> {
    Document::new_in(catalogue(), MemoryStore::default(), IdSource::sequential()).unwrap()
}

fn pom(store: &MemoryStore) -> Pom<Oblique> {
    let store = store.clone();
    Pom::new_in(
        catalogue(),
        move || Box::new(store.clone()),
        IdSource::sequential,
    )
    .unwrap()
}

/// A `SceneNode` as TypeScript builds it (src/scene/types.ts).
fn node(id: &str, kind: &str) -> Json {
    let mut n = json!({
        "id": id,
        "type": kind,
        "label": "Layer",
        "state": "active",
        "output": "image",
        "visible": true,
        "blendMode": "normal",
        "opacity": 1.0,
        "modifiers": [],
    });
    let extra = match kind {
        "pixel" => json!({"sourcePath": "photo.png", "sourceSize": [640.0, 480.0]}),
        "vector" => json!({
            "paths": [{"anchors": [{"point": {"x": 1.0, "y": 2.0}}], "closed": false}],
            "fillRule": "nonzero",
        }),
        _ => json!({
            "content": "Hello",
            "label": "Hello",
            "font": {"family": "Inter", "style": "Regular", "postscriptName": "Inter-Regular",
                     "weight": 400.0, "italic": false, "category": "sans-serif"},
            "fontSize": 72.0,
            "tracking": 0.0,
            "kerning": 100.0,
            "lineHeight": 1.2,
            "align": "left",
            "fill": "#ffffff",
            "stroke": null,
            "position": {"x": 10.0, "y": 20.0},
        }),
    };
    n.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    n
}

fn add(d: &mut Document<Oblique>, n: Json) -> rhizome_pom::Result<Outcome> {
    d.run("layer.add", &json!({ "node": n }))
}

fn set(
    d: &mut Document<Oblique>,
    at: &str,
    key: &str,
    value: Json,
) -> rhizome_pom::Result<Outcome> {
    d.run(
        "values.set",
        &json!({"changes": [{"at": at, "key": key, "value": value}]}),
    )
}

fn text(d: &mut Document<Oblique>, at: &str, patch: Json) -> rhizome_pom::Result<Outcome> {
    d.run("text.set", &json!({"at": at, "patch": patch}))
}

fn value(d: &Document<Oblique>, at: &str, key: &str) -> Option<Value> {
    d.tree().at(at).and_then(|n| n.value(key))
}

fn stack(d: &Document<Oblique>) -> Vec<String> {
    d.tree()
        .at("/layers")
        .unwrap()
        .order("stack")
        .iter()
        .map(|n| n.name().to_string())
        .collect()
}

fn lock(d: &mut Document<Oblique>, at: &str) {
    // Locking has no command yet (Epic 21 story 6); the lock state is written directly.
    d.edit("Lock", |tx| {
        tx.set_value(at, "state", Value::Choice("locked".into()))
    })
    .unwrap();
}

// ---- seed ----

#[test]
fn a_new_document_has_its_document_node_with_oblique_defaults() {
    let d = doc();
    let at = "/document/document";
    assert_eq!(d.tree().at(at).unwrap().type_name(), "document");
    assert_eq!(value(&d, at, "documentSize"), Some(Value::Vec2([0.0, 0.0])));
    assert_eq!(
        value(&d, at, "resolution"),
        Some(Value::Choice("working".into()))
    );
    assert_eq!(value(&d, at, "note"), Some(Value::Text(String::new())));
    // the scene id is the node's own id
    let id = d.tree().at(at).unwrap().id().to_string();
    assert_eq!(value(&d, at, "sceneId"), Some(Value::Text(id)));
    assert!(d.tree().at("/layers").is_some());
}

#[test]
fn the_seed_is_not_an_undo_step_and_not_unsaved() {
    let mut d = doc();
    assert_eq!(d.tree().history_len(), 0);
    assert!(d.tree().undo_label().is_none());
    assert!(!d.is_unsaved());
    assert!(d.undo().unwrap().is_none());
    // the document node can't be removed or duplicated
    assert!(!d.policy("document").deletable);
    assert!(!d.policy("document").duplicable);
}

// ---- layer.add ----

#[test]
fn a_new_layer_goes_on_top_of_the_stack() {
    let mut d = doc();
    for id in ["a", "b", "c"] {
        add(&mut d, node(id, "pixel")).unwrap();
    }
    assert_eq!(stack(&d), ["c", "b", "a"]);
    assert_eq!(d.tree().at("/layers/c").unwrap().type_name(), "pixel");
}

#[test]
fn layer_add_stores_the_node_typescript_built() {
    let mut d = doc();
    let mut n = node("v", "vector");
    n["transform2d"] = json!({"x": 5.0, "y": 6.0, "scaleX": 2.0, "scaleY": 3.0, "rotation": 0.5});
    n["opacity"] = json!(0.25);
    add(&mut d, n).unwrap();
    assert_eq!(value(&d, "/layers/v", "opacity"), Some(Value::Float(0.25)));
    assert_eq!(
        value(&d, "/layers/v", "transform2d.position"),
        Some(Value::Vec2([5.0, 6.0]))
    );
    assert_eq!(
        value(&d, "/layers/v", "transform2d.scale"),
        Some(Value::Vec2([2.0, 3.0]))
    );
    assert_eq!(
        value(&d, "/layers/v", "transform2d.rotation"),
        Some(Value::Float(0.5))
    );
    // an absent transform2d reads as identity: the keys stay unset
    add(&mut d, node("p", "pixel")).unwrap();
    assert!(!d
        .tree()
        .at("/layers/p")
        .unwrap()
        .is_set("transform2d.position"));
    assert_eq!(
        value(&d, "/layers/p", "transform2d.scale"),
        Some(Value::Vec2([1.0, 1.0]))
    );
    // a text layer takes its text keys
    add(&mut d, node("t", "text")).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Hello".into()))
    );
}

#[test]
fn layer_add_refuses_a_duplicate_id_and_changes_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    assert!(add(&mut d, node("a", "vector")).is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
    assert_eq!(stack(&d), ["a"]);
}

#[test]
fn layer_add_is_one_undo_step_and_undo_removes_the_layer() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let mut n = node("b", "pixel");
    n["modifiers"] =
        json!([{"id": "m1", "type": "blur", "enabled": true, "params": {"radius": 12.0}}]);
    add(&mut d, n).unwrap();
    assert_eq!(d.tree().history_len(), 2);
    assert_eq!(d.tree().undo_label(), Some("New pixel"));
    d.undo().unwrap();
    assert_eq!(stack(&d), ["a"]);
    assert!(d.tree().at("/layers/b").is_none());
    d.undo().unwrap();
    assert!(stack(&d).is_empty());
    assert!(d.undo().unwrap().is_none());
    d.redo().unwrap();
    d.redo().unwrap();
    assert_eq!(stack(&d), ["b", "a"]);
    assert!(d.tree().at("/layers/b/m1").is_some());
}

#[test]
fn layer_add_refuses_what_isnt_a_layer_or_doesnt_fit() {
    let mut d = doc();
    assert!(add(&mut d, node("a", "camera")).is_err());
    assert!(add(&mut d, json!({"type": "pixel"})).is_err(), "no id");
    let mut bad = node("b", "pixel");
    bad["opacity"] = json!(7.0);
    assert!(add(&mut d, bad).is_err(), "opacity is hard-capped at 1");
    // a refused add leaves no half-made layer
    assert!(stack(&d).is_empty());
    assert!(d.tree().at("/layers/b").is_none());
    assert_eq!(d.tree().history_len(), 0);
    // the command isn't enabled without a node
    assert!(!d.is_enabled("layer.add", &json!({})).unwrap());
}

// ---- values.set ----

#[test]
fn values_set_writes_transform_and_layer_props_in_one_step() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let steps = d.tree().history_len();
    d.run(
        "values.set",
        &json!({"changes": [
            {"at": "/layers/a", "key": "transform2d.position", "value": [10.0, 20.0]},
            {"at": "/layers/a", "key": "transform2d.scale", "value": [2.0, 2.0]},
            {"at": "/layers/a", "key": "transform2d.rotation", "value": 1.5},
            {"at": "/layers/a", "key": "opacity", "value": 0.5},
            {"at": "/layers/a", "key": "blendMode", "value": "multiply"},
            {"at": "/layers/a", "key": "visible", "value": false},
            {"at": "/layers/a", "key": "label", "value": "Sky"},
        ]}),
    )
    .unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(
        value(&d, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([10.0, 20.0]))
    );
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(0.5)));
    assert_eq!(
        value(&d, "/layers/a", "blendMode"),
        Some(Value::Choice("multiply".into()))
    );
    assert_eq!(value(&d, "/layers/a", "visible"), Some(Value::Bool(false)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Sky".into()))
    );
    d.undo().unwrap();
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(1.0)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Layer".into()))
    );
}

#[test]
fn values_set_refuses_keys_that_arent_moved_yet() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    for (at, key, v) in [
        ("/layers/a", "state", json!("locked")),
        ("/layers/a", "sourceSize", json!([1.0, 1.0])),
        ("/layers/a", "transform", json!(vec![0.0; 16])),
        ("/layers/t", "content", json!("sneaky")),
        ("/document/document", "documentSize", json!([10.0, 10.0])),
        ("/document/document", "note", json!("hi")),
    ] {
        let e = set(&mut d, at, key, v).unwrap_err();
        assert!(e.to_string().contains("isn't on rhizome yet"), "{key}: {e}");
    }
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), 2);
}

#[test]
fn values_set_is_all_or_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let before = d.tree().serialise();
    let r = d.run(
        "values.set",
        &json!({"changes": [
            {"at": "/layers/a", "key": "opacity", "value": 0.5},
            {"at": "/layers/a", "key": "opacity", "value": 3.0},
        ]}),
    );
    assert!(r.is_err());
    assert_eq!(d.tree().serialise(), before);
    assert!(set(&mut d, "/layers/nope", "opacity", json!(0.5)).is_err());
    assert!(set(&mut d, "/layers/a", "blendMode", json!("dissolve")).is_err());
    assert!(set(&mut d, "/layers/a", "visible", json!("yes")).is_err());
}

#[test]
fn a_drag_of_value_writes_is_one_undo_step() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let steps = d.tree().history_len();
    for x in 1..=20 {
        let payload = json!({"changes": [
            {"at": "/layers/a", "key": "transform2d.position", "value": [x as f64, 0.0]},
        ]});
        d.run_coalesced("values.set", &payload, "drag:a").unwrap();
    }
    assert_eq!(d.tree().history_len(), steps + 1);
    d.undo().unwrap();
    assert!(!d
        .tree()
        .at("/layers/a")
        .unwrap()
        .is_set("transform2d.position"));
}

// ---- locks ----

#[test]
fn a_locked_layer_refuses_transform_and_text_writes() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    lock(&mut d, "/layers/a");
    lock(&mut d, "/layers/t");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for (key, v) in [
        ("transform2d.position", json!([1.0, 1.0])),
        ("transform2d.scale", json!([2.0, 2.0])),
        ("transform2d.rotation", json!(1.0)),
    ] {
        let e = set(&mut d, "/layers/a", key, v).unwrap_err();
        assert!(e.to_string().contains("is locked"), "{key}: {e}");
    }
    // a batch with one guarded key is refused whole
    let e = d
        .run(
            "values.set",
            &json!({"changes": [
                {"at": "/layers/a", "key": "opacity", "value": 0.5},
                {"at": "/layers/a", "key": "transform2d.rotation", "value": 1.0},
            ]}),
        )
        .unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    let e = text(&mut d, "/layers/t", json!({"content": "changed"})).unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn compositing_props_stay_writable_on_a_locked_layer() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    for (key, v) in [
        ("opacity", json!(0.5)),
        ("blendMode", json!("screen")),
        ("visible", json!(false)),
        ("label", json!("x")),
        ("output", json!("mask")),
    ] {
        set(&mut d, "/layers/a", key, v.clone()).unwrap_or_else(|e| panic!("{key}: {e}"));
        assert_eq!(
            d.tree()
                .at("/layers/a")
                .unwrap()
                .value(key)
                .unwrap()
                .to_json(),
            v,
            "{key}"
        );
    }
}

#[test]
fn locking_one_layer_leaves_the_others_writable() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("b", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    set(
        &mut d,
        "/layers/b",
        "transform2d.position",
        json!([1.0, 2.0]),
    )
    .unwrap();
    // unlocking (undo of the lock edit here) makes it writable again
    d.undo().unwrap(); // the move
    d.undo().unwrap(); // the lock
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([1.0, 2.0]),
    )
    .unwrap();
}

// ---- text.set ----

#[test]
fn the_label_follows_the_content_while_it_is_automatic() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    text(
        &mut d,
        "/layers/t",
        json!({"content": "  \n  World  \nsecond line"}),
    )
    .unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("  \n  World  \nsecond line".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("World".into()))
    );
    text(&mut d, "/layers/t", json!({"content": ""})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Text".into()))
    );
    let long = "x".repeat(40);
    text(&mut d, "/layers/t", json!({"content": long})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text(format!("{}…", "x".repeat(32))))
    );
}

#[test]
fn the_label_stops_following_once_set_explicitly() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    set(&mut d, "/layers/t", "label", json!("My title")).unwrap();
    text(&mut d, "/layers/t", json!({"content": "Other"})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Other".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("My title".into()))
    );
}

#[test]
fn a_text_patch_without_content_leaves_the_label_alone() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    text(
        &mut d,
        "/layers/t",
        json!({"fontSize": 40.0, "align": "center"}),
    )
    .unwrap();
    assert_eq!(value(&d, "/layers/t", "fontSize"), Some(Value::Float(40.0)));
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    // content and label are one undo step
    text(&mut d, "/layers/t", json!({"content": "Bye"})).unwrap();
    d.undo().unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Hello".into()))
    );
}

#[test]
fn text_set_refuses_non_text_layers_unknown_props_and_missing_layers() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    assert!(text(&mut d, "/layers/a", json!({"content": "x"})).is_err());
    assert!(text(&mut d, "/layers/t", json!({"opacity": 0.5})).is_err());
    assert!(text(&mut d, "/layers/t", json!({"content": "x", "label": "y"})).is_err());
    assert!(text(&mut d, "/layers/nope", json!({"content": "x"})).is_err());
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn the_label_helper_matches_the_stores() {
    assert_eq!(super::text_label(""), "Text");
    assert_eq!(super::text_label("\n  \n"), "Text");
    assert_eq!(super::text_label("  hi  \nthere"), "hi");
    assert_eq!(
        super::text_label(&"é".repeat(33)),
        format!("{}…", "é".repeat(32))
    );
    assert_eq!(super::text_label(&"é".repeat(32)), "é".repeat(32));
}

// ---- op params ----

fn blur(d: &Document<Oblique>) -> rhizome_core::NodeType {
    d.tree().registry().node_type("op.blur").cloned().unwrap()
}

#[test]
fn an_ops_params_are_namespaced_so_they_never_meet_the_modifiers_own_values() {
    let d = doc();
    let t = blur(&d);
    let keys: Vec<&str> = t.values().iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys[0], "enabled");
    for k in [
        "params.radius",
        "params.steps",
        "params.gain",
        "params.mode",
        "params.tint",
        "params.on",
    ] {
        assert!(keys.contains(&k), "{k} in {keys:?}");
    }
    assert!(!keys.contains(&"radius"));
    assert_eq!(super::op_type("blur"), "op.blur");
    assert_eq!(super::param_key("radius"), "params.radius");
}

#[test]
fn an_op_param_named_enabled_cannot_clash_with_the_modifiers_switch() {
    let d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![Op {
            name: "odd".into(),
            params: vec![param("enabled", "bool", json!(false), None, None)],
        }])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    let t = d.tree().registry().node_type("op.odd").cloned().unwrap();
    let keys: Vec<&str> = t.values().iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["enabled", "params.enabled"]);
}

#[test]
fn float_and_int_params_have_a_soft_max_and_a_hard_min() {
    let d = doc();
    let t = blur(&d);
    let spec = |k: &str| t.values().iter().find(|s| s.key == k).cloned().unwrap();
    let radius = spec("params.radius");
    assert_eq!(radius.range, Some((0.0, 100.0)));
    assert!(radius.soft_max);
    assert!(spec("params.steps").soft_max);
    // no range declared: unbounded
    let gain = spec("params.gain");
    assert_eq!(gain.range, None);
    assert_eq!(gain.default, Value::Float(1.0));
    // enum, colour and bool params
    assert_eq!(spec("params.mode").choices, ["soft", "hard"]);
    assert_eq!(spec("params.tint").default, Value::Text("#ff0000".into()));
    assert_eq!(spec("params.on").default, Value::Bool(true));
}

#[test]
fn a_param_may_go_past_its_max_but_never_under_its_min() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    // layer.add stores the modifiers TypeScript built; a typed value past the slider's end
    // (decision 53) is kept as written
    let mut n = node("b", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true,
        "params": {"radius": 250.0, "steps": 99, "gain": -4.0, "mode": "hard", "tint": "#00ff00", "on": false}}]);
    add(&mut d, n).unwrap();
    let m = "/layers/b/m";
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(250.0)));
    assert_eq!(value(&d, m, "params.steps"), Some(Value::Int(99)));
    assert_eq!(value(&d, m, "params.gain"), Some(Value::Float(-4.0)));
    assert_eq!(
        value(&d, m, "params.mode"),
        Some(Value::Choice("hard".into()))
    );
    assert_eq!(
        value(&d, m, "params.tint"),
        Some(Value::Text("#00ff00".into()))
    );
    assert_eq!(value(&d, m, "params.on"), Some(Value::Bool(false)));
    // an unset param reads as the op's default
    let mut n = node("c", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true, "params": {}}]);
    add(&mut d, n).unwrap();
    assert_eq!(
        value(&d, "/layers/c/m", "params.radius"),
        Some(Value::Float(5.0))
    );
    assert_eq!(value(&d, "/layers/c/m", "enabled"), Some(Value::Bool(true)));
    // the min still holds, and refusing it takes the whole layer.add back
    let steps = d.tree().history_len();
    for bad in [
        json!({"radius": -0.5}),
        json!({"steps": 0}),
        json!({"mode": "medium"}),
    ] {
        let mut n = node("d", "pixel");
        n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true, "params": bad}]);
        assert!(add(&mut d, n).is_err(), "{bad}");
    }
    assert!(d.tree().at("/layers/d").is_none());
    assert_eq!(d.tree().history_len(), steps);
    // an op the catalogue doesn't have is refused too
    let mut n = node("e", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "unknown", "enabled": true, "params": {}}]);
    assert!(add(&mut d, n).is_err());
}

#[test]
fn a_soft_max_holds_for_a_later_write_and_a_load_does_not_clamp_it() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    let mut n = node("a", "pixel");
    n["modifiers"] =
        json!([{"id": "m", "type": "blur", "enabled": true, "params": {"radius": 10.0}}]);
    add(&mut d, n).unwrap();
    let m = "/layers/a/m";
    d.edit("Radius", |tx| {
        tx.set_value(m, "params.radius", Value::Float(1e6))
    })
    .unwrap();
    assert!(d
        .edit("Radius", |tx| tx.set_value(
            m,
            "params.radius",
            Value::Float(-1.0)
        ))
        .is_err());
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(1e6)));
    // through a file: soft max values survive a load
    d.save_as("/mem/a.oblique").unwrap();
    let (back, report) =
        Document::<Oblique>::open_in(catalogue(), store, "/mem/a.oblique", IdSource::sequential())
            .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(value(&back, m, "params.radius"), Some(Value::Float(1e6)));
}

// ---- document.set_size ----

#[test]
fn set_size_writes_the_document_size_in_one_undo_step() {
    let mut d = doc();
    d.run("document.set_size", &json!({"size": [1920.0, 1080.0]}))
        .unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([1920.0, 1080.0]))
    );
    assert_eq!(d.tree().undo_label(), Some("Document Size"));
    assert!(d.is_unsaved());
    d.undo().unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([0.0, 0.0]))
    );
    assert!(!d.is_unsaved(), "undone back to what was saved");
    d.redo().unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([1920.0, 1080.0]))
    );
}

#[test]
fn set_size_refuses_what_isnt_a_size() {
    let mut d = doc();
    assert!(d.run("document.set_size", &json!({"size": [1.0]})).is_err());
    assert!(d.run("document.set_size", &json!({"size": "big"})).is_err());
    assert!(d
        .run("document.set_size", &json!({"size": [1.0, f64::NAN]}))
        .is_err());
    assert!(!d.is_enabled("document.set_size", &json!({})).unwrap());
    assert_eq!(d.tree().history_len(), 0);
}

// ---- undo / redo ----

#[test]
fn undo_and_redo_walk_each_step_down_to_the_empty_document_and_no_further() {
    let mut d = doc();
    let empty = d.tree().serialise();
    d.run("document.set_size", &json!({"size": [100.0, 100.0]}))
        .unwrap();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    set(&mut d, "/layers/a", "opacity", json!(0.5)).unwrap();
    text(&mut d, "/layers/t", json!({"content": "Bye"})).unwrap();
    let full = d.tree().serialise();
    let mut seen = vec![full.clone()];
    while d.undo().unwrap().is_some() {
        seen.push(d.tree().serialise());
    }
    assert_eq!(seen.len(), 6);
    assert_eq!(d.tree().serialise(), empty);
    assert!(!d.is_unsaved());
    assert!(d.undo().unwrap().is_none());
    // redo retraces the same states
    seen.reverse();
    for want in &seen[1..] {
        d.redo().unwrap().unwrap();
        assert_eq!(&d.tree().serialise(), want);
    }
    assert!(d.redo().unwrap().is_none());
    assert_eq!(d.tree().serialise(), full);
}

#[test]
fn a_new_edit_after_undo_drops_redo() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    d.undo().unwrap();
    assert!(d.tree().redo_label().is_some());
    add(&mut d, node("b", "pixel")).unwrap();
    assert!(d.tree().redo_label().is_none());
}

#[test]
fn a_gesture_is_one_undo_step_and_cancel_takes_it_back() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let g = d.begin("Move").unwrap();
    for x in 1..=5 {
        set(
            &mut d,
            "/layers/a",
            "transform2d.position",
            json!([x as f64, 0.0]),
        )
        .unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), 2);
    let g = d.begin("Move").unwrap();
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([99.0, 0.0]),
    )
    .unwrap();
    d.cancel(g).unwrap();
    assert_eq!(
        value(&d, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([5.0, 0.0]))
    );
    assert_eq!(d.tree().history_len(), 2);
}

// ---- files ----

fn busy(d: &mut Document<Oblique>) {
    d.run("document.set_size", &json!({"size": [800.0, 600.0]}))
        .unwrap();
    add(d, node("a", "pixel")).unwrap();
    let mut v = node("v", "vector");
    v["modifiers"] = json!([
        {"id": "m1", "type": "blur", "enabled": true, "params": {"radius": 250.0, "mode": "hard"}},
        {"id": "m2", "type": "blur", "enabled": false, "params": {}},
    ]);
    add(d, v).unwrap();
    add(d, node("t", "text")).unwrap();
    set(d, "/layers/a", "transform2d.position", json!([3.0, 4.5])).unwrap();
    set(d, "/layers/v", "opacity", json!(0.4)).unwrap();
    text(d, "/layers/t", json!({"content": "Réunion"})).unwrap();
}

#[test]
fn a_save_and_open_round_trip_reproduces_the_tree_exactly() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    busy(&mut d);
    assert!(d.is_unsaved());
    d.save_as("/mem/work").unwrap();
    // the extension is added
    assert_eq!(d.path().unwrap().extension().unwrap(), "oblique");
    assert!(!d.is_unsaved());
    let saved = d.tree().serialise();
    assert_eq!(
        store.get("/mem/work.oblique").as_deref(),
        Some(saved.as_str())
    );

    let (back, report) = Document::<Oblique>::open_in(
        catalogue(),
        store.clone(),
        "/mem/work.oblique",
        IdSource::sequential(),
    )
    .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(back.tree().serialise(), saved);
    assert!(!back.is_unsaved());
    assert_eq!(stack(&back), ["t", "v", "a"]);
    // order of modifiers, ref and values all survive
    assert_eq!(
        value(&back, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([3.0, 4.5]))
    );
    assert_eq!(
        value(&back, "/layers/v/m1", "params.radius"),
        Some(Value::Float(250.0))
    );
    let order: Vec<String> = back
        .tree()
        .at("/layers/v")
        .unwrap()
        .order("modifiers")
        .iter()
        .map(|n| n.name().to_string())
        .collect();
    assert_eq!(order, ["m1", "m2"]);
    assert_eq!(
        back.tree()
            .at("/layers/a")
            .unwrap()
            .reference("source")
            .cloned(),
        d.tree()
            .at("/layers/a")
            .unwrap()
            .reference("source")
            .cloned(),
    );
    // history starts empty after an open
    assert_eq!(back.tree().history_len(), 0);
}

#[test]
fn a_file_that_isnt_rhizomes_is_refused_with_its_own_error() {
    let store = MemoryStore::default();
    store.put(
        "/mem/old.oblique",
        r#"{"scene": {"nodes": []}, "version": 3}"#,
    );
    assert!(Document::<Oblique>::open_in(
        catalogue(),
        store.clone(),
        "/mem/old.oblique",
        IdSource::sequential()
    )
    .is_err());
    assert!(Document::<Oblique>::open_in(
        catalogue(),
        store,
        "/mem/missing.oblique",
        IdSource::sequential()
    )
    .is_err());
}

#[test]
fn the_host_saves_opens_and_reports_unsaved_through_its_status() {
    let store = MemoryStore::default();
    let pom = pom(&store);
    let s = pom.status();
    assert!(!s.unsaved && s.undo.is_none() && s.path.is_none());
    assert_eq!(s.title, "Untitled");

    let (_, events) = pom
        .run("layer.add", &json!({"node": node("a", "pixel")}), None)
        .unwrap();
    assert!(!events.is_empty());
    let s = pom.status();
    assert!(s.unsaved);
    assert_eq!(s.undo.as_deref(), Some("New pixel"));
    assert_eq!(s.title, "Untitled — Edited");

    pom.save_as(std::path::Path::new("/mem/h.oblique")).unwrap();
    let saved = pom.tree();
    assert!(!pom.status().unsaved);
    assert_eq!(pom.status().title, "h.oblique");

    // a new document replaces it, no undo, not unsaved, and the generation moves
    let gen = pom.status().generation;
    pom.new_document().unwrap();
    let s = pom.status();
    assert!(!s.unsaved && s.undo.is_none());
    assert!(s.generation > gen);
    assert_eq!(pom.read(stack), Vec::<String>::new());

    let (issues, _) = pom.open(std::path::Path::new("/mem/h.oblique")).unwrap();
    assert!(issues.is_empty());
    assert_eq!(pom.tree(), saved);
    assert!(!pom.status().unsaved);
    assert!(pom.status().undo.is_none());
    assert_eq!(pom.read(stack), ["a"]);
}

#[test]
fn the_host_refuses_a_write_to_a_missing_layer_and_names_it() {
    let store = MemoryStore::default();
    let pom = pom(&store);
    pom.run("layer.add", &json!({"node": node("a", "pixel")}), None)
        .unwrap();
    let before = pom.tree();
    let e = pom
        .run(
            "values.set",
            &json!({"changes": [{"at": "/layers/zzz", "key": "opacity", "value": 0.5}]}),
            None,
        )
        .unwrap_err();
    assert!(e.to_string().contains("/layers/zzz"), "{e}");
    assert_eq!(pom.tree(), before);
}

// ---- POM built-ins that write the tree ----

#[test]
fn pom_builtins_that_write_the_tree_refuse_and_change_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    let args = json!({
        "at": "/layers/a", "key": "transform2d.rotation", "value": 1.0,
        "parent": "/layers", "type": "pixel", "name": "b",
        "fragment": "", "label": "x", "to": "y", "text": "",
    });
    for id in [
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
    ] {
        let e = d.run(id, &args).unwrap_err();
        assert!(e.to_string().contains("isn't on rhizome yet"), "{id}: {e}");
        assert_eq!(d.tree().serialise(), before, "{id}");
        assert_eq!(d.tree().history_len(), steps, "{id}");
    }
    // undo, redo and the read-only built-ins still work
    assert!(d.is_enabled("edit.undo", &json!({})).unwrap());
    d.undo().unwrap();
    d.redo().unwrap();
    assert!(matches!(
        d.run("edit.copy", &json!({"at": "/layers/a"})).unwrap(),
        Outcome::Text(_)
    ));
}

// ---- param ranges with one end ----

#[test]
fn a_param_with_only_a_min_keeps_it_and_is_unbounded_above() {
    let ops = Op {
        name: "one_sided".into(),
        params: vec![
            param("floor", "float", json!(2.0), Some(1.0), None),
            param("ceiling", "float", json!(2.0), None, Some(10.0)),
            param("count", "int", json!(2), Some(1.0), None),
        ],
    };
    let mut d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![ops])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    let mut n = node("a", "pixel");
    let m =
        |params: Json| json!([{"id": "m", "type": "one_sided", "enabled": true, "params": params}]);
    n["modifiers"] = m(json!({"floor": 1e9, "ceiling": -1e9, "count": 5000}));
    add(&mut d, n).unwrap();
    assert_eq!(
        value(&d, "/layers/a/m", "params.floor"),
        Some(Value::Float(1e9))
    );
    assert_eq!(
        value(&d, "/layers/a/m", "params.ceiling"),
        Some(Value::Float(-1e9))
    );
    assert_eq!(
        value(&d, "/layers/a/m", "params.count"),
        Some(Value::Int(5000))
    );
    for bad in [json!({"floor": 0.5}), json!({"count": 0})] {
        let mut n = node("b", "pixel");
        n["modifiers"] = m(bad.clone());
        assert!(add(&mut d, n).is_err(), "{bad}");
    }
    let t = d
        .tree()
        .registry()
        .node_type("op.one_sided")
        .cloned()
        .unwrap();
    let floor = t.values().iter().find(|s| s.key == "params.floor").unwrap();
    assert!(floor.soft_max);
    assert_eq!(floor.range.map(|r| r.0), Some(1.0));
}

#[test]
fn the_document_host_shares_its_pom_with_the_transports_host() {
    let (document, transport) = DocumentHost::new(pom(&MemoryStore::default()));
    let told = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let seen = told.clone();
    document.on_change(move || {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });

    // a command through the transport's host (what `pom_run` calls) ...
    transport
        .host()
        .run("layer.add", &json!({ "node": node("a", "pixel") }), None)
        .unwrap();

    // ... is in the document Oblique's own Rust reads, and the hook heard of it
    document.pom().read(|d| {
        assert!(d.tree().at("/layers/a").is_some());
    });
    assert_eq!(told.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(document.untitled_number(), 1);
    assert_eq!(document.next_untitled(), 2);
    assert_eq!(document.untitled_number(), 2);
}
