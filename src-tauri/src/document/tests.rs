//! The object model's contracts, with no window: every write is a command, one undo step
//! each, and the domain rules (locks, labels, soft max) hold however the webview behaves.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use preset_app_kit::{
    edit_titles, Document as _, DocumentState, History as _, HistoryState, NOTE_EVENT,
};
use rhizome_core::{IdSource, On, Value};
use rhizome_pom::{Document, FileStore, Host, MemoryStore, Outcome, Pom};
use rhizome_pom_tauri::PomHost;
use serde_json::{json, Value as Json};
use tauri::test::{mock_app, MockRuntime};
use tauri::Listener as _;

use super::host::{DOCUMENT_OPENED, DOCUMENT_SAVED, HISTORY_STEPPED, NOT_READY};
use super::{
    fit_replaced_transform, refit_attach_transform, sidecar_catalogue, Catalogue, DocumentHost,
    Oblique, Op, OpParam, Placement, DUPLICATE_OFFSET_PX,
};

fn param(name: &str, kind: &str, default: Json, min: Option<f64>, max: Option<f64>) -> OpParam {
    OpParam {
        name: name.into(),
        label: None,
        description: None,
        kind: kind.into(),
        default,
        min,
        max,
        choice_labels: Default::default(),
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
        label: None,
        description: None,
        category: None,
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
    d.run("layer.set_state", &json!({"at": at, "state": "locked"}))
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
            label: None,
            description: None,
            category: None,
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

// ---- layer.set_source ----

fn set_source(
    d: &mut Document<Oblique>,
    at: &str,
    path: &str,
    size: Option<[f64; 2]>,
) -> rhizome_pom::Result<Outcome> {
    let mut p = json!({"at": at, "sourcePath": path});
    if let Some(size) = size {
        p["sourceSize"] = json!(size);
    }
    d.run("layer.set_source", &p)
}

/// A pixel layer as the TypeScript replace-source tests build it: 512x512, moved, flipped
/// horizontally and turned.
fn placed(id: &str) -> Json {
    let mut n = node(id, "pixel");
    n["sourcePath"] = json!("/old/a.png");
    n["sourceSize"] = json!([512.0, 512.0]);
    n["transform2d"] =
        json!({"x": 100.0, "y": 40.0, "scaleX": -1.0, "scaleY": 1.0, "rotation": 0.3});
    n
}

fn placement(d: &Document<Oblique>, at: &str) -> Placement {
    let f = |key: &str| match value(d, at, key) {
        Some(Value::Vec2(v)) => v,
        other => panic!("{key}: {other:?}"),
    };
    let Some(Value::Float(rotation)) = value(d, at, "transform2d.rotation") else {
        panic!("no rotation");
    };
    Placement {
        x: f("transform2d.position")[0],
        y: f("transform2d.position")[1],
        scale_x: f("transform2d.scale")[0],
        scale_y: f("transform2d.scale")[1],
        rotation,
    }
}

fn source_of(d: &Document<Oblique>, at: &str) -> String {
    d.tree()
        .at(at)
        .unwrap()
        .reference("source")
        .and_then(|r| r.file.clone())
        .unwrap_or_default()
}

/// A modifier named `id` with a mask on `layer`: a vector layer `v` bound onto its mask slot.
fn with_masks(d: &mut Document<Oblique>, layer: Json, masks: &[(&str, Json)]) {
    let mut layer = layer;
    layer["modifiers"] = json!(masks
        .iter()
        .enumerate()
        .map(|(i, _)| json!({"id": format!("m{}", i + 1), "type": "blur", "enabled": true, "params": {}}))
        .collect::<Vec<_>>());
    add(d, layer.clone()).unwrap();
    add(d, node("v", "vector")).unwrap();
    let id = layer["id"].as_str().unwrap().to_string();
    for (i, (mask, attach)) in masks.iter().enumerate() {
        let space = if attach.is_null() {
            Json::Null
        } else {
            json!("node")
        };
        d.edit("Mask", |tx| {
            tx.bind(
                format!("/layers/{id}/m{}", i + 1).as_str(),
                On::slot("mask"),
                "/layers/v",
                [
                    ("refId", Value::Text(mask.to_string())),
                    ("featherPx", Value::Float(0.0)),
                    ("expand", Value::Float(0.0)),
                    ("invert", Value::Bool(false)),
                    ("space", Value::Shaped(space)),
                    ("attachTransform", Value::Shaped(attach.clone())),
                ],
            )
        })
        .unwrap();
    }
}

fn mask_value(d: &Document<Oblique>, modifier: &str, key: &str) -> Json {
    d.tree().at(modifier).unwrap().bindings()[0]
        .value(key)
        .unwrap()
        .to_json()
}

fn attach_of(d: &Document<Oblique>, modifier: &str) -> Placement {
    Placement::from_json(&mask_value(d, modifier, "attachTransform")).unwrap()
}

/// Node-local -> document space for a node with transform `t` and source `w`x`h`: scale and
/// rotate about the box centre (src/scene/maskRasterize.ts `localToDocMatrix`).
fn local_to_doc(t: Placement, w: f64, h: f64, px: f64, py: f64) -> (f64, f64) {
    let (cos, sin) = (t.rotation.cos(), t.rotation.sin());
    let (cx, cy) = (t.x + w / 2.0, t.y + h / 2.0);
    let (a, b, c, d) = (
        cos * t.scale_x,
        sin * t.scale_x,
        -sin * t.scale_y,
        cos * t.scale_y,
    );
    let e = cx - (a * (w / 2.0) + c * (h / 2.0));
    let f = cy - (b * (w / 2.0) + d * (h / 2.0));
    (a * px + c * py + e, b * px + d * py + f)
}

/// Its inverse (`docToLocalMatrix`).
fn doc_to_local(t: Placement, w: f64, h: f64, px: f64, py: f64) -> (f64, f64) {
    let (cos, sin) = (t.rotation.cos(), t.rotation.sin());
    let sx = if t.scale_x == 0.0 {
        0.0
    } else {
        1.0 / t.scale_x
    };
    let sy = if t.scale_y == 0.0 {
        0.0
    } else {
        1.0 / t.scale_y
    };
    let (cx, cy) = (t.x + w / 2.0, t.y + h / 2.0);
    let (a, c, b, d) = (cos * sx, sin * sx, -sin * sy, cos * sy);
    let e = w / 2.0 - (a * cx + c * cy);
    let f = h / 2.0 - (b * cx + d * cy);
    (a * px + c * py + e, b * px + d * py + f)
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} vs {b}");
}

fn near_placement(a: Placement, b: Placement) {
    near(a.x, b.x);
    near(a.y, b.y);
    near(a.scale_x, b.scale_x);
    near(a.scale_y, b.scale_y);
    near(a.rotation, b.rotation);
}

fn identity() -> Placement {
    Placement {
        x: 0.0,
        y: 0.0,
        scale_x: 1.0,
        scale_y: 1.0,
        rotation: 0.0,
    }
}

#[test]
fn set_source_without_a_size_changes_only_the_path() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let before = placement(&d, "/layers/a");
    set_source(&mut d, "/layers/a", "/elsewhere.png", None).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/elsewhere.png");
    assert_eq!(
        value(&d, "/layers/a", "sourceSize"),
        Some(Value::Vec2([512.0, 512.0]))
    );
    assert_eq!(placement(&d, "/layers/a"), before);
    // the same size is a path-only change too: nothing to fit
    set_source(&mut d, "/layers/a", "/same.png", Some([512.0, 512.0])).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/same.png");
    assert_eq!(placement(&d, "/layers/a"), before);
}

#[test]
fn set_source_with_nothing_new_is_not_a_step() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let steps = d.tree().history_len();
    let before = d.tree().serialise();
    set_source(&mut d, "/layers/a", "/old/a.png", Some([512.0, 512.0])).unwrap();
    set_source(&mut d, "/layers/a", "/old/a.png", None).unwrap();
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn set_source_is_one_undo_step_named_replace_image() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    set_source(&mut d, "/layers/a", "/new/b.png", Some([4000.0, 2000.0])).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(d.tree().undo_label().as_deref(), Some("Replace Image"));
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before);
    d.redo().unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/new/b.png");
}

#[test]
fn set_source_with_a_new_size_fits_the_old_footprint() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    set_source(&mut d, "/layers/a", "/new/b.png", Some([4000.0, 2000.0])).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/new/b.png");
    assert_eq!(
        value(&d, "/layers/a", "sourceSize"),
        Some(Value::Vec2([4000.0, 2000.0]))
    );
    let t = placement(&d, "/layers/a");
    // the box stays 512 wide and becomes 256 tall, centred where it was
    near(4000.0 * t.scale_x.abs(), 512.0);
    near(2000.0 * t.scale_y.abs(), 256.0);
    near(t.rotation, 0.3);
    assert!(t.scale_x < 0.0 && t.scale_y > 0.0, "flip survives: {t:?}");
    let old = Placement {
        x: 100.0,
        y: 40.0,
        scale_x: -1.0,
        scale_y: 1.0,
        rotation: 0.3,
    };
    let (bx, by) = local_to_doc(old, 512.0, 512.0, 256.0, 256.0);
    let (ax, ay) = local_to_doc(t, 4000.0, 2000.0, 2000.0, 1000.0);
    near(ax, bx);
    near(ay, by);
    // everything else about the layer is untouched
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(1.0)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Layer".into()))
    );
}

#[test]
fn set_source_fits_a_layer_that_was_never_moved() {
    let mut d = doc();
    let mut n = node("a", "pixel");
    n["sourceSize"] = json!([100.0, 100.0]);
    add(&mut d, n).unwrap();
    set_source(&mut d, "/layers/a", "/new.png", Some([50.0, 25.0])).unwrap();
    let t = placement(&d, "/layers/a");
    near(t.scale_x, 2.0);
    near(t.scale_y, 2.0);
    let (cx, cy) = local_to_doc(t, 50.0, 25.0, 25.0, 12.5);
    near(cx, 50.0);
    near(cy, 50.0);
}

#[test]
fn fit_replaced_transform_cases() {
    // 512x512 -> 4000x2000 from {100, 40}
    let t = fit_replaced_transform(
        Placement {
            x: 100.0,
            y: 40.0,
            ..identity()
        },
        [512.0, 512.0],
        [4000.0, 2000.0],
    );
    near(4000.0 * t.scale_x.abs(), 512.0);
    near(2000.0 * t.scale_y.abs(), 256.0);

    // rotated, h-flipped, moved, non-uniformly scaled: centre, rotation and flip kept, uniform fit
    let old = Placement {
        x: -37.0,
        y: 211.0,
        scale_x: -1.5,
        scale_y: 0.75,
        rotation: 0.6,
    };
    let (w0, h0, w1, h1) = (640.0, 480.0, 300.0, 900.0);
    let next = fit_replaced_transform(old, [w0, h0], [w1, h1]);
    assert_eq!(next.rotation, old.rotation);
    assert!(next.scale_x < 0.0 && next.scale_y > 0.0);
    near(next.scale_x.abs(), next.scale_y.abs());
    let (c0, c1) = (
        local_to_doc(old, w0, h0, w0 / 2.0, h0 / 2.0),
        local_to_doc(next, w1, h1, w1 / 2.0, h1 / 2.0),
    );
    near(c1.0, c0.0);
    near(c1.1, c0.1);
    // the new image's corners, in the old node's local frame, sit inside the old box and touch it
    let corners: Vec<(f64, f64)> = [(0.0, 0.0), (w1, 0.0), (w1, h1), (0.0, h1)]
        .iter()
        .map(|(x, y)| {
            let (dx, dy) = local_to_doc(next, w1, h1, *x, *y);
            doc_to_local(old, w0, h0, dx, dy)
        })
        .collect();
    for (x, y) in &corners {
        assert!(
            *x > -1e-6 && *x < w0 + 1e-6 && *y > -1e-6 && *y < h0 + 1e-6,
            "{x},{y}"
        );
    }
    let (min_x, max_x) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| {
        (lo.min(p.0), hi.max(p.0))
    });
    let (min_y, max_y) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| {
        (lo.min(p.1), hi.max(p.1))
    });
    assert!((min_x < 1e-6 && max_x > w0 - 1e-6) || (min_y < 1e-6 && max_y > h0 - 1e-6));

    // a collapsed old footprint keeps its scale and still preserves the centre
    let collapsed = fit_replaced_transform(
        Placement {
            x: 10.0,
            y: 10.0,
            scale_x: 0.0,
            scale_y: 1.0,
            rotation: 0.0,
        },
        [100.0, 100.0],
        [40.0, 40.0],
    );
    assert_eq!((collapsed.scale_x, collapsed.scale_y), (0.0, 1.0));
    near(collapsed.x + 20.0, 10.0 + 50.0);
}

#[test]
fn set_source_refits_a_node_space_mask_and_leaves_a_document_space_one() {
    let mut d = doc();
    let attach = json!({"x": 100.0, "y": 40.0, "scaleX": -1.0, "scaleY": 1.0, "rotation": 0.3});
    with_masks(
        &mut d,
        placed("a"),
        &[("mask1", attach.clone()), ("mask2", Json::Null)],
    );
    let doc_space = mask_value(&d, "/layers/a/m2", "attachTransform");
    set_source(&mut d, "/layers/a", "/new/b.png", Some([1024.0, 256.0])).unwrap();
    let next = placement(&d, "/layers/a");
    // the same node frame at attach time as now: the refitted snapshot IS the new transform
    let refit = attach_of(&d, "/layers/a/m1");
    assert_ne!(refit, Placement::from_json(&attach).unwrap());
    near_placement(refit, next);
    // the rest of the binding survives, and the document-space mask is untouched
    assert_eq!(mask_value(&d, "/layers/a/m1", "refId"), json!("mask1"));
    assert_eq!(mask_value(&d, "/layers/a/m1", "space"), json!("node"));
    assert_eq!(mask_value(&d, "/layers/a/m2", "attachTransform"), doc_space);
    assert_eq!(mask_value(&d, "/layers/a/m2", "space"), Json::Null);
    assert_eq!(mask_value(&d, "/layers/a/m2", "refId"), json!("mask2"));
    // one step, and undo puts the snapshot back too
    assert_eq!(d.tree().undo_label().as_deref(), Some("Replace Image"));
    d.undo().unwrap();
    assert_eq!(
        Placement::from_json(&mask_value(&d, "/layers/a/m1", "attachTransform")).unwrap(),
        Placement::from_json(&attach).unwrap()
    );
}

#[test]
fn a_node_space_mask_covers_the_same_canvas_region_after_the_replace() {
    let mut d = doc();
    let mut n = node("a", "pixel");
    n["sourceSize"] = json!([800.0, 600.0]);
    n["transform2d"] =
        json!({"x": 50.0, "y": -20.0, "scaleX": -1.25, "scaleY": 0.8, "rotation": 0.4});
    let attach = json!({"x": 10.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.1});
    with_masks(&mut d, n, &[("mask1", attach.clone())]);
    let old = placement(&d, "/layers/a");
    let attach0 = Placement::from_json(&attach).unwrap();
    set_source(&mut d, "/layers/a", "/new.png", Some([1200.0, 500.0])).unwrap();
    let next = placement(&d, "/layers/a");
    let attach1 = attach_of(&d, "/layers/a/m1");
    for (px, py) in [(0.0, 0.0), (123.0, 456.0), (-50.0, 700.0), (900.0, 90.0)] {
        // a shape point (document space) goes into the mask buffer through the snapshot, then
        // out through the node's placement
        let (lx, ly) = doc_to_local(attach0, 800.0, 600.0, px, py);
        let (bx, by) = local_to_doc(old, 800.0, 600.0, lx, ly);
        let (lx, ly) = doc_to_local(attach1, 1200.0, 500.0, px, py);
        let (ax, ay) = local_to_doc(next, 1200.0, 500.0, lx, ly);
        near(ax, bx);
        near(ay, by);
    }
    // without the refit the mask would have moved
    let (lx, ly) = doc_to_local(attach0, 1200.0, 500.0, 100.0, 100.0);
    let (ax, ay) = local_to_doc(next, 1200.0, 500.0, lx, ly);
    let (lx, ly) = doc_to_local(attach0, 800.0, 600.0, 100.0, 100.0);
    let (bx, by) = local_to_doc(old, 800.0, 600.0, lx, ly);
    assert!((ax - bx).hypot(ay - by) > 1.0);
    // and the pure rule agrees with what the command wrote
    near_placement(
        refit_attach_transform(attach0, old, next, [800.0, 600.0], [1200.0, 500.0]),
        attach1,
    );
}

#[test]
fn set_source_on_a_locked_layer_is_refused_and_changes_nothing() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    lock(&mut d, "/layers/a");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for size in [None, Some([4000.0, 2000.0])] {
        let e = set_source(&mut d, "/layers/a", "/new/b.png", size).unwrap_err();
        assert!(e.to_string().contains("is locked"), "{e}");
    }
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn set_source_on_a_layer_that_is_not_a_pixel_layer_is_refused() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for at in ["/layers/v", "/layers/t"] {
        let e = set_source(&mut d, at, "/new/b.png", Some([10.0, 10.0])).unwrap_err();
        assert!(e.to_string().contains("isn't a pixel layer"), "{at}: {e}");
    }
    let e = set_source(&mut d, "/layers/zzz", "/new/b.png", None).unwrap_err();
    assert!(e.to_string().contains("/layers/zzz"), "{e}");
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

// ---- layer edits: layer.remove, layer.reorder, layer.duplicate ----

/// Runs `edit`, which must be one undo step named `label`: undo gives back the exact tree it
/// started from, and redo the exact tree it made.
fn is_one_undo_step(
    d: &mut Document<Oblique>,
    label: &str,
    edit: impl FnOnce(&mut Document<Oblique>),
) {
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    edit(d);
    assert_eq!(d.tree().history_len(), steps + 1, "one undo step");
    assert_eq!(d.tree().undo_label(), Some(label));
    let after = d.tree().serialise();
    assert_ne!(after, before, "the edit changed something");
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before, "undo restores the exact tree");
    assert_eq!(d.tree().history_len(), steps);
    d.redo().unwrap();
    assert_eq!(d.tree().serialise(), after, "redo gives the edit back");
}

fn remove(d: &mut Document<Oblique>, at: &str) -> rhizome_pom::Result<Outcome> {
    d.run("layer.remove", &json!({ "at": at }))
}

fn reorder(d: &mut Document<Oblique>, at: &str, to: i64) -> rhizome_pom::Result<Outcome> {
    d.run("layer.reorder", &json!({ "at": at, "to": to }))
}

fn duplicate(
    d: &mut Document<Oblique>,
    at: &str,
    id: &str,
    modifiers: &[&str],
    masks: &[Option<&str>],
) -> rhizome_pom::Result<Outcome> {
    d.run(
        "layer.duplicate",
        &json!({"at": at, "id": id, "modifierIds": modifiers, "maskIds": masks}),
    )
}

/// The mask bindings on a modifier: (source layer name, refId).
fn masks_of(d: &Document<Oblique>, modifier: &str) -> Vec<(String, String)> {
    d.tree()
        .at(modifier)
        .unwrap()
        .bindings()
        .iter()
        .map(|b| {
            let Some(Value::Text(r)) = b.value("refId") else {
                panic!("no refId")
            };
            (b.source.name().to_string(), r)
        })
        .collect()
}

#[test]
fn remove_deletes_the_layer_and_its_modifiers_in_one_undo_step() {
    let mut d = doc();
    let mut n = node("b", "pixel");
    n["modifiers"] =
        json!([{"id": "m1", "type": "blur", "enabled": true, "params": {"radius": 12.0}}]);
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, n).unwrap();
    add(&mut d, node("c", "text")).unwrap();
    is_one_undo_step(&mut d, "Delete Layer", |d| {
        remove(d, "/layers/b").unwrap();
        assert_eq!(stack(d), ["c", "a"]);
        assert!(d.tree().at("/layers/b").is_none());
        assert!(d.tree().at("/layers/b/m1").is_none());
    });
    // the redo is still in force: now bring it back and check the layer is whole
    d.undo().unwrap();
    assert_eq!(stack(&d), ["c", "b", "a"]);
    assert!(d.tree().at("/layers/b/m1").is_some());
}

#[test]
fn remove_takes_the_bindings_sourced_from_the_removed_layer_with_it() {
    let mut d = doc();
    // `a` consumes the vector layer `v` through two modifiers, `w` through none; `z` is a
    // second consumer of `v`
    with_masks(
        &mut d,
        placed("a"),
        &[
            (
                "r1",
                json!({"x": 1.0, "y": 2.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0}),
            ),
            ("r2", Json::Null),
        ],
    );
    add(&mut d, node("w", "vector")).unwrap();
    assert_eq!(masks_of(&d, "/layers/a/m1"), [("v".into(), "r1".into())]);

    is_one_undo_step(&mut d, "Delete Layer", |d| {
        let Outcome::Committed(c) = remove(d, "/layers/v").unwrap() else {
            panic!("not committed")
        };
        // no modifier keeps a dangling mask ...
        for m in ["/layers/a/m1", "/layers/a/m2"] {
            assert!(d.tree().at(m).unwrap().bindings().is_empty(), "{m}");
        }
        // ... and the patch the webview's mirror applies names those modifiers, or it would
        // keep a binding to a layer that is gone
        let patch = d.tree().patch(&c.changes);
        let rows: Vec<String> = patch.rows.iter().map(|r| r.path.to_string()).collect();
        assert!(rows.contains(&"/layers/a/m1".to_string()), "{rows:?}");
        assert!(rows.contains(&"/layers/a/m2".to_string()), "{rows:?}");
        assert!(rows.contains(&"/layers".to_string()), "{rows:?}");
        for m in &patch.rows {
            assert!(m.bindings.is_empty(), "{}", m.path);
        }
        assert_eq!(patch.removed.len(), 1);
    });
    // undo brought both back: the layer and the masks that point at it
    d.undo().unwrap();
    assert_eq!(masks_of(&d, "/layers/a/m1"), [("v".into(), "r1".into())]);
    assert_eq!(masks_of(&d, "/layers/a/m2"), [("v".into(), "r2".into())]);
    assert_eq!(mask_value(&d, "/layers/a/m1", "space"), json!("node"));
}

#[test]
fn removing_a_consumer_leaves_the_mask_layer_alone() {
    let mut d = doc();
    with_masks(&mut d, placed("a"), &[("r1", Json::Null)]);
    remove(&mut d, "/layers/a").unwrap();
    assert_eq!(stack(&d), ["v"]);
}

#[test]
fn remove_allows_a_locked_layer() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    is_one_undo_step(&mut d, "Delete Layer", |d| {
        remove(d, "/layers/a").unwrap();
        assert!(stack(d).is_empty());
    });
}

#[test]
fn the_layer_commands_refuse_what_is_not_a_layer_and_change_nothing() {
    let mut d = doc();
    let mut n = node("a", "pixel");
    n["modifiers"] = json!([{"id": "m1", "type": "blur", "enabled": true, "params": {}}]);
    add(&mut d, n).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for at in [
        "/layers/a/m1",
        "/document/document",
        "/layers",
        "/layers/zzz",
    ] {
        for e in [
            remove(&mut d, at),
            reorder(&mut d, at, 0),
            duplicate(&mut d, at, "x", &[], &[]),
        ] {
            assert!(e.is_err(), "{at}");
        }
    }
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

/// The store's `reorderNode`: splice out, splice in (src/scene/store.ts).
fn spliced(stack: &[&str], id: &str, to: usize) -> Vec<String> {
    let mut v: Vec<String> = stack.iter().map(|s| s.to_string()).collect();
    let from = v.iter().position(|s| s == id).unwrap();
    let n = v.remove(from);
    v.insert(to, n);
    v
}

#[test]
fn reorder_matches_the_stores_for_top_bottom_and_middle_moves() {
    for (id, to) in [
        ("d", 3),
        ("a", 0),
        ("c", 2),
        ("b", 0),
        ("a", 1),
        ("d", 1),
        ("c", 3),
        ("b", 3),
    ] {
        let mut d = doc();
        for l in ["a", "b", "c", "d"] {
            add(&mut d, node(l, "pixel")).unwrap(); // the stack is d, c, b, a
        }
        let want = spliced(&["d", "c", "b", "a"], id, to);
        let at = format!("/layers/{id}");
        is_one_undo_step(&mut d, "Move Layer", |d| {
            reorder(d, &at, to as i64).unwrap();
            assert_eq!(stack(d), want, "{id} to {to}");
        });
    }
}

#[test]
fn reorder_clamps_an_index_out_of_range_to_the_nearest_end() {
    let mut d = doc();
    for l in ["a", "b", "c"] {
        add(&mut d, node(l, "pixel")).unwrap(); // c, b, a
    }
    reorder(&mut d, "/layers/c", 99).unwrap();
    assert_eq!(stack(&d), ["b", "a", "c"]);
    reorder(&mut d, "/layers/c", -5).unwrap();
    assert_eq!(stack(&d), ["c", "b", "a"]);
}

#[test]
fn reorder_to_where_it_already_is_is_not_a_step() {
    let mut d = doc();
    for l in ["a", "b", "c"] {
        add(&mut d, node(l, "pixel")).unwrap();
    }
    let steps = d.tree().history_len();
    assert!(matches!(
        reorder(&mut d, "/layers/b", 1).unwrap(),
        Outcome::Nothing
    ));
    assert!(matches!(
        reorder(&mut d, "/layers/c", -3).unwrap(),
        Outcome::Nothing
    ));
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn reorder_allows_a_locked_layer_and_touches_nothing_else() {
    let mut d = doc();
    for l in ["a", "b", "c"] {
        add(&mut d, node(l, "pixel")).unwrap();
    }
    lock(&mut d, "/layers/c");
    let Outcome::Committed(c) = reorder(&mut d, "/layers/c", 2).unwrap() else {
        panic!("not committed")
    };
    assert_eq!(stack(&d), ["b", "a", "c"]);
    // compositing only: the order changed, no layer's own values did
    let patch = d.tree().patch(&c.changes);
    let rows: Vec<String> = patch.rows.iter().map(|r| r.path.to_string()).collect();
    assert_eq!(rows, ["/layers"]);
}

fn masked_original(d: &mut Document<Oblique>) {
    let attach = json!({"x": 5.0, "y": 6.0, "scaleX": 2.0, "scaleY": 1.5, "rotation": 0.4});
    let mut layer = placed("a");
    layer["label"] = json!("Photo");
    with_masks(d, layer, &[("r1", attach), ("r2", Json::Null)]);
    d.edit("Prepare", |tx| {
        tx.set_value("/layers/a/m1", "params.radius", Value::Float(12.0))?;
        tx.set_value("/layers/a/m2", "enabled", Value::Bool(false))?;
        // m2 has no mask
        tx.unbind("/layers/a/m2", On::slot("mask"), "/layers/v")
    })
    .unwrap();
}

#[test]
fn duplicate_copies_the_label_offset_state_modifiers_and_masks() {
    let mut d = doc();
    masked_original(&mut d);
    assert_eq!(stack(&d), ["v", "a"]);
    let original = Placement {
        x: 100.0,
        y: 40.0,
        scale_x: -1.0,
        scale_y: 1.0,
        rotation: 0.3,
    };
    is_one_undo_step(&mut d, "Duplicate Layer", |d| {
        duplicate(d, "/layers/a", "a2", &["n1", "n2"], &[Some("q1"), None]).unwrap();
        // directly above the original
        assert_eq!(stack(d), ["v", "a2", "a"]);
        assert_eq!(
            value(d, "/layers/a2", "label"),
            Some(Value::Text("Photo copy".into()))
        );
        assert_eq!(
            value(d, "/layers/a2", "state"),
            Some(Value::Choice("active".into()))
        );
        let copy = placement(d, "/layers/a2");
        near_placement(
            copy,
            Placement {
                x: original.x + DUPLICATE_OFFSET_PX,
                y: original.y + DUPLICATE_OFFSET_PX,
                ..original
            },
        );
        assert_eq!(source_of(d, "/layers/a2"), "/old/a.png");
        assert_eq!(
            value(d, "/layers/a2", "sourceSize"),
            Some(Value::Vec2([512.0, 512.0]))
        );
        // fresh modifier ids, in the original's order, with the original's values
        let order: Vec<String> = d
            .tree()
            .at("/layers/a2")
            .unwrap()
            .order("modifiers")
            .iter()
            .map(|n| n.name().to_string())
            .collect();
        assert_eq!(order, ["n1", "n2"]);
        assert_eq!(
            value(d, "/layers/a2/n1", "params.radius"),
            Some(Value::Float(12.0))
        );
        assert_eq!(
            value(d, "/layers/a2/n2", "enabled"),
            Some(Value::Bool(false))
        );
        // the mask: same source, same values, a fresh refId; the unmasked one stays unmasked
        assert_eq!(masks_of(d, "/layers/a2/n1"), [("v".into(), "q1".into())]);
        assert!(d.tree().at("/layers/a2/n2").unwrap().bindings().is_empty());
        for key in ["featherPx", "expand", "invert", "space", "attachTransform"] {
            assert_eq!(
                mask_value(d, "/layers/a2/n1", key),
                mask_value(d, "/layers/a/m1", key),
                "{key}"
            );
        }
        // the original is untouched
        assert_eq!(masks_of(d, "/layers/a/m1"), [("v".into(), "r1".into())]);
        near_placement(placement(d, "/layers/a"), original);
        assert_eq!(
            value(d, "/layers/a", "label"),
            Some(Value::Text("Photo".into()))
        );
    });
}

#[test]
fn duplicating_a_layer_that_was_never_moved_puts_the_copy_at_the_offset() {
    let mut d = doc();
    add(&mut d, node("a", "vector")).unwrap();
    assert!(!d
        .tree()
        .at("/layers/a")
        .unwrap()
        .is_set("transform2d.position"));
    duplicate(&mut d, "/layers/a", "a2", &[], &[]).unwrap();
    near_placement(
        placement(&d, "/layers/a2"),
        Placement {
            x: DUPLICATE_OFFSET_PX,
            y: DUPLICATE_OFFSET_PX,
            ..identity()
        },
    );
    assert_eq!(
        value(&d, "/layers/a2", "fillRule"),
        Some(Value::Choice("nonzero".into()))
    );
    assert_eq!(
        value(&d, "/layers/a2", "paths"),
        value(&d, "/layers/a", "paths")
    );
}

#[test]
fn duplicating_a_text_layer_copies_its_text() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    duplicate(&mut d, "/layers/t", "t2", &[], &[]).unwrap();
    for key in [
        "content", "font", "fontSize", "fill", "stroke", "position", "align",
    ] {
        assert_eq!(
            value(&d, "/layers/t2", key),
            value(&d, "/layers/t", key),
            "{key}"
        );
    }
    // the label no longer follows the content: "Hello copy" isn't the content's own label
    assert_eq!(
        value(&d, "/layers/t2", "label"),
        Some(Value::Text("Hello copy".into()))
    );
}

#[test]
fn a_duplicate_of_a_locked_layer_is_active() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    duplicate(&mut d, "/layers/a", "a2", &[], &[]).unwrap();
    assert_eq!(
        value(&d, "/layers/a2", "state"),
        Some(Value::Choice("active".into()))
    );
    assert_eq!(
        value(&d, "/layers/a", "state"),
        Some(Value::Choice("locked".into()))
    );
}

#[test]
fn a_duplicate_can_be_duplicated_and_stays_above_its_original() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("b", "pixel")).unwrap();
    duplicate(&mut d, "/layers/a", "a2", &[], &[]).unwrap();
    duplicate(&mut d, "/layers/a2", "a3", &[], &[]).unwrap();
    assert_eq!(stack(&d), ["b", "a3", "a2", "a"]);
    assert_eq!(
        value(&d, "/layers/a3", "label"),
        Some(Value::Text("Layer copy copy".into()))
    );
    near_placement(
        placement(&d, "/layers/a3"),
        Placement {
            x: 2.0 * DUPLICATE_OFFSET_PX,
            y: 2.0 * DUPLICATE_OFFSET_PX,
            ..identity()
        },
    );
}

#[test]
fn duplicate_refuses_a_taken_id_and_ids_that_do_not_match_the_modifiers() {
    let mut d = doc();
    masked_original(&mut d);
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    // the layer id is taken
    assert!(duplicate(&mut d, "/layers/a", "v", &["n1", "n2"], &[Some("q1"), None]).is_err());
    // too few modifier ids, too few mask ids, a masked modifier with no mask id
    assert!(duplicate(&mut d, "/layers/a", "a2", &["n1"], &[Some("q1")]).is_err());
    assert!(duplicate(&mut d, "/layers/a", "a2", &["n1", "n2"], &[Some("q1")]).is_err());
    assert!(duplicate(&mut d, "/layers/a", "a2", &["n1", "n2"], &[None, None]).is_err());
    // a modifier id twice
    assert!(duplicate(
        &mut d,
        "/layers/a",
        "a2",
        &["n1", "n1"],
        &[Some("q1"), None]
    )
    .is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

// ---- modifiers and masks: modifier.* and mask.* ----

fn run(d: &mut Document<Oblique>, id: &str, args: Json) -> rhizome_pom::Result<Outcome> {
    d.run(id, &args)
}

/// The names of a layer's modifiers, in its `modifiers` order.
fn modifier_names(d: &Document<Oblique>, layer: &str) -> Vec<String> {
    d.tree()
        .at(layer)
        .unwrap()
        .order("modifiers")
        .iter()
        .map(|n| n.name().to_string())
        .collect()
}

/// A pixel layer `a` with a modifier per id, none masked.
fn with_modifiers(d: &mut Document<Oblique>, ids: &[&str]) {
    let mut n = node("a", "pixel");
    n["modifiers"] = json!(ids
        .iter()
        .map(|id| json!({"id": id, "type": "blur", "enabled": true, "params": {}}))
        .collect::<Vec<_>>());
    add(d, n).unwrap();
}

/// A catalogue whose ops and params have panel labels, as `list_ops` reports them.
fn labelled() -> Document<Oblique> {
    let mut radius = param("radius", "float", json!(5.0), Some(0.0), Some(100.0));
    radius.label = Some("Blur radius".into());
    Document::new_in(
        Arc::new(Catalogue(vec![Op {
            name: "gaussian_blur".into(),
            label: Some("Gaussian blur".into()),
            description: None,
            category: None,
            params: vec![radius],
        }])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap()
}

#[test]
fn modifier_add_appends_last_with_every_param_written_in_one_undo_step() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("b", "pixel")).unwrap();
    is_one_undo_step(&mut d, "Add Blur", |d| {
        run(
            d,
            "modifier.add",
            json!({"at": "/layers/a", "id": "m2", "type": "blur"}),
        )
        .unwrap();
        assert_eq!(modifier_names(d, "/layers/a"), ["m1", "m2"]);
        // every param is stored, not read through its default: the row names what it holds
        let n = d.tree().at("/layers/a/m2").unwrap();
        for (k, v) in [
            ("enabled", Value::Bool(true)),
            ("params.radius", Value::Float(5.0)),
            ("params.steps", Value::Int(3)),
            ("params.gain", Value::Float(1.0)),
            ("params.mode", Value::Choice("soft".into())),
            ("params.tint", Value::Text("#ff0000".into())),
            ("params.on", Value::Bool(true)),
        ] {
            assert_eq!(n.value(k), Some(v), "{k}");
            assert!(n.is_set(k), "{k} is stored");
        }
    });
    // the first modifier of a layer makes its order
    run(
        &mut d,
        "modifier.add",
        json!({"at": "/layers/b", "id": "x", "type": "blur"}),
    )
    .unwrap();
    assert_eq!(modifier_names(&d, "/layers/b"), ["x"]);
}

#[test]
fn modifier_add_takes_the_params_a_duplicate_modifier_carries() {
    let mut d = doc();
    with_modifiers(&mut d, &[]);
    run(
        &mut d,
        "modifier.add",
        json!({"at": "/layers/a", "id": "m", "type": "blur",
               "params": {"radius": 250.0, "steps": 99, "mode": "hard"}}),
    )
    .unwrap();
    let m = "/layers/a/m";
    // past the soft max is kept; what it didn't name is the default
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(250.0)));
    assert_eq!(value(&d, m, "params.steps"), Some(Value::Int(99)));
    assert_eq!(
        value(&d, m, "params.mode"),
        Some(Value::Choice("hard".into()))
    );
    assert_eq!(value(&d, m, "params.gain"), Some(Value::Float(1.0)));
}

#[test]
fn modifier_add_refuses_what_it_cannot_make_and_changes_nothing() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for (args, why) in [
        (
            json!({"at": "/layers/a", "id": "m1", "type": "blur"}),
            "an id that is taken",
        ),
        (
            json!({"at": "/layers/a", "id": "n", "type": "no_such_op"}),
            "an op the catalogue lacks",
        ),
        (
            json!({"at": "/layers/nope", "id": "n", "type": "blur"}),
            "a layer that isn't there",
        ),
        (
            json!({"at": "/layers/a/m1", "id": "n", "type": "blur"}),
            "a modifier as the layer",
        ),
        (
            json!({"at": "/layers/a", "id": "n", "type": "blur", "params": {"nope": 1}}),
            "a param the op lacks",
        ),
        (
            json!({"at": "/layers/a", "id": "n", "type": "blur", "params": {"radius": -1.0}}),
            "a param under its min",
        ),
        (
            json!({"at": "/layers/a", "id": "n", "type": "blur", "params": {"radius": "wide"}}),
            "a param of the wrong type",
        ),
    ] {
        assert!(run(&mut d, "modifier.add", args).is_err(), "{why}");
        assert_eq!(d.tree().serialise(), before, "{why}");
        assert_eq!(d.tree().history_len(), steps, "{why}");
    }
}

#[test]
fn modifier_steps_are_named_for_the_op_and_param_labels() {
    let mut d = labelled();
    add(&mut d, node("a", "pixel")).unwrap();
    run(
        &mut d,
        "modifier.add",
        json!({"at": "/layers/a", "id": "m", "type": "gaussian_blur"}),
    )
    .unwrap();
    assert_eq!(d.tree().undo_label(), Some("Add Gaussian blur"));
    run(
        &mut d,
        "modifier.set",
        json!({"at": "/layers/a/m", "key": "params.radius", "value": 9.0}),
    )
    .unwrap();
    assert_eq!(d.tree().undo_label(), Some("Set Blur radius"));
    // without a label the name is made readable
    let mut d = doc();
    with_modifiers(&mut d, &["m"]);
    run(
        &mut d,
        "modifier.set",
        json!({"at": "/layers/a/m", "key": "params.radius", "value": 9.0}),
    )
    .unwrap();
    assert_eq!(d.tree().undo_label(), Some("Set Radius"));
}

#[test]
fn modifier_remove_drops_its_mask_and_keeps_the_layer_that_was_the_mask() {
    let mut d = doc();
    with_masks(
        &mut d,
        placed("a"),
        &[("r1", Json::Null), ("r2", Json::Null)],
    );
    is_one_undo_step(&mut d, "Remove Modifier", |d| {
        run(d, "modifier.remove", json!({"at": "/layers/a/m1"})).unwrap();
        assert_eq!(modifier_names(d, "/layers/a"), ["m2"]);
        assert!(d.tree().at("/layers/a/m1").is_none());
        // the shape stays, and the other modifier still uses it
        assert_eq!(stack(d), ["v", "a"]);
        assert_eq!(masks_of(d, "/layers/a/m2"), [("v".into(), "r2".into())]);
        assert!(d.tree().at("/layers/v").unwrap().bound_to().len() == 1);
    });
    // the last modifier takes the order with it
    run(&mut d, "modifier.remove", json!({"at": "/layers/a/m2"})).unwrap();
    assert!(modifier_names(&d, "/layers/a").is_empty());
    assert!(d.tree().at("/layers/v").unwrap().bound_to().is_empty());
}

#[test]
fn the_modifier_commands_refuse_what_is_not_a_modifier() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    let before = d.tree().serialise();
    for (id, args) in [
        ("modifier.remove", json!({"at": "/layers/a"})),
        ("modifier.remove", json!({"at": "/document/document"})),
        ("modifier.reorder", json!({"at": "/layers/a", "to": 0})),
        (
            "modifier.set",
            json!({"at": "/layers/a", "key": "enabled", "value": false}),
        ),
        ("mask.detach", json!({"at": "/layers/a"})),
        (
            "mask.set_space",
            json!({"at": "/layers/a", "space": "node"}),
        ),
    ] {
        let e = run(&mut d, id, args).unwrap_err();
        assert!(e.to_string().contains("isn't a modifier"), "{id}: {e}");
    }
    // and layer.remove still refuses a modifier (story 3)
    assert!(remove(&mut d, "/layers/a/m1").is_err());
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn modifier_reorder_matches_the_stores_for_top_bottom_and_middle_moves() {
    let ids = ["m1", "m2", "m3", "m4"];
    for from in 0..4usize {
        for to in 0..4usize {
            let mut d = doc();
            with_modifiers(&mut d, &ids);
            let mut want: Vec<&str> = ids.to_vec();
            let moved = want.remove(from);
            want.insert(to, moved);
            let at = format!("/layers/a/{}", ids[from]);
            let r = run(&mut d, "modifier.reorder", json!({"at": at, "to": to}));
            assert_eq!(modifier_names(&d, "/layers/a"), want, "{from} -> {to}");
            if from == to {
                assert_eq!(r.unwrap(), Outcome::Nothing, "no move is no step");
            }
        }
    }
    let mut d = doc();
    with_modifiers(&mut d, &ids);
    is_one_undo_step(&mut d, "Move Modifier", |d| {
        run(
            d,
            "modifier.reorder",
            json!({"at": "/layers/a/m4", "to": 0}),
        )
        .unwrap();
        assert_eq!(modifier_names(d, "/layers/a"), ["m4", "m1", "m2", "m3"]);
    });
    // out of range clamps to the nearest end
    run(
        &mut d,
        "modifier.reorder",
        json!({"at": "/layers/a/m1", "to": 99}),
    )
    .unwrap();
    assert_eq!(modifier_names(&d, "/layers/a"), ["m4", "m2", "m3", "m1"]);
    run(
        &mut d,
        "modifier.reorder",
        json!({"at": "/layers/a/m1", "to": -5}),
    )
    .unwrap();
    assert_eq!(modifier_names(&d, "/layers/a"), ["m1", "m4", "m2", "m3"]);
}

#[test]
fn modifier_set_keeps_a_value_past_the_soft_max_and_refuses_the_wrong_type_or_a_hard_min() {
    let mut d = doc();
    with_modifiers(&mut d, &["m"]);
    let m = "/layers/a/m";
    let set_m = |d: &mut Document<Oblique>, key: &str, v: Json| {
        run(d, "modifier.set", json!({"at": m, "key": key, "value": v}))
    };
    set_m(&mut d, "params.radius", json!(250.0)).unwrap();
    set_m(&mut d, "params.steps", json!(99)).unwrap();
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(250.0)));
    assert_eq!(value(&d, m, "params.steps"), Some(Value::Int(99)));
    // an integer-looking number is a float for a float param
    set_m(&mut d, "params.gain", json!(2)).unwrap();
    assert_eq!(value(&d, m, "params.gain"), Some(Value::Float(2.0)));

    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for (key, v, why) in [
        ("params.radius", json!("wide"), "text for a float"),
        ("params.steps", json!(2.5), "a fraction for an int"),
        ("params.on", json!(1), "a number for a bool"),
        ("params.mode", json!("medium"), "an unknown choice"),
        ("params.radius", json!(-0.5), "under the hard min"),
        ("enabled", json!("yes"), "text for the switch"),
        ("params.nope", json!(1), "a param the op lacks"),
        ("radius", json!(1.0), "a bare name"),
        ("label", json!("x"), "a key that isn't the modifier's"),
        ("state", json!("locked"), "a key that isn't the modifier's"),
    ] {
        assert!(set_m(&mut d, key, v).is_err(), "{why}");
        assert_eq!(d.tree().serialise(), before, "{why}");
        assert_eq!(d.tree().history_len(), steps, "{why}");
    }
}

#[test]
fn modifier_set_covers_enabled_and_names_the_step() {
    let mut d = doc();
    with_modifiers(&mut d, &["m"]);
    is_one_undo_step(&mut d, "Disable Modifier", |d| {
        run(
            d,
            "modifier.set",
            json!({"at": "/layers/a/m", "key": "enabled", "value": false}),
        )
        .unwrap();
        assert_eq!(value(d, "/layers/a/m", "enabled"), Some(Value::Bool(false)));
    });
    run(
        &mut d,
        "modifier.set",
        json!({"at": "/layers/a/m", "key": "enabled", "value": true}),
    )
    .unwrap();
    assert_eq!(d.tree().undo_label(), Some("Enable Modifier"));
}

#[test]
fn a_param_scrub_inside_a_gesture_is_one_undo_step() {
    let mut d = doc();
    with_modifiers(&mut d, &["m"]);
    let steps = d.tree().history_len();
    let before = d.tree().serialise();
    let g = d.begin("Edit").unwrap();
    for r in 1..=8 {
        run(
            &mut d,
            "modifier.set",
            json!({"at": "/layers/a/m", "key": "params.radius", "value": r as f64 * 10.0}),
        )
        .unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(
        value(&d, "/layers/a/m", "params.radius"),
        Some(Value::Float(80.0))
    );
    d.undo().unwrap();
    assert_eq!(
        d.tree().serialise(),
        before,
        "one undo takes back the whole scrub"
    );
}

#[test]
fn every_modifier_and_mask_command_refuses_a_locked_consumer_and_changes_nothing() {
    let mut d = doc();
    with_masks(
        &mut d,
        placed("a"),
        &[("r1", Json::Null), ("r2", Json::Null)],
    );
    add(&mut d, node("w", "vector")).unwrap();
    lock(&mut d, "/layers/a");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for (id, args) in [
        (
            "modifier.add",
            json!({"at": "/layers/a", "id": "n", "type": "blur"}),
        ),
        ("modifier.remove", json!({"at": "/layers/a/m1"})),
        ("modifier.reorder", json!({"at": "/layers/a/m1", "to": 1})),
        (
            "modifier.set",
            json!({"at": "/layers/a/m1", "key": "params.radius", "value": 9.0}),
        ),
        (
            "modifier.set",
            json!({"at": "/layers/a/m1", "key": "enabled", "value": false}),
        ),
        (
            "mask.attach",
            json!({"at": "/layers/a/m1", "source": "/layers/w",
                   "featherPx": 1.0, "expand": 0.0, "invert": false}),
        ),
        ("mask.detach", json!({"at": "/layers/a/m1"})),
        (
            "mask.set_space",
            json!({"at": "/layers/a/m1", "space": "node"}),
        ),
        (
            "mask.from_marquee",
            json!({"at": "/layers/a/m1", "vectorId": "sel", "paths": [],
                   "fillRule": "evenodd", "label": "Selection (rect)",
                   "featherPx": 0.0, "expand": 0.0, "invert": false}),
        ),
    ] {
        let e = run(&mut d, id, args).unwrap_err();
        assert!(e.to_string().contains("is locked"), "{id}: {e}");
        assert_eq!(d.tree().serialise(), before, "{id}");
        assert_eq!(d.tree().history_len(), steps, "{id}");
    }
    // the mask layer being locked is not the consumer's lock: it still attaches
    unlock(&mut d, "/layers/a");
    lock(&mut d, "/layers/w");
    run(
        &mut d,
        "mask.attach",
        json!({"at": "/layers/a/m1", "source": "/layers/w",
               "featherPx": 1.0, "expand": 0.0, "invert": false}),
    )
    .unwrap();
}

fn unlock(d: &mut Document<Oblique>, at: &str) {
    d.run("layer.set_state", &json!({"at": at, "state": "active"}))
        .unwrap();
}

fn attach(
    d: &mut Document<Oblique>,
    at: &str,
    source: &str,
    feather: f64,
) -> rhizome_pom::Result<Outcome> {
    run(
        d,
        "mask.attach",
        json!({"at": at, "source": source, "featherPx": feather, "expand": 2.0, "invert": true}),
    )
}

#[test]
fn mask_attach_binds_the_slot_with_its_values_and_the_modifiers_own_id_as_the_ref() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("v", "vector")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    is_one_undo_step(&mut d, "Attach Mask", |d| {
        attach(d, "/layers/a/m1", "/layers/v", 3.0).unwrap();
        assert_eq!(masks_of(d, "/layers/a/m1"), [("v".into(), "m1".into())]);
        assert_eq!(mask_value(d, "/layers/a/m1", "featherPx"), json!(3.0));
        assert_eq!(mask_value(d, "/layers/a/m1", "expand"), json!(2.0));
        assert_eq!(mask_value(d, "/layers/a/m1", "invert"), json!(true));
        // document space: the optional values read as unset
        assert_eq!(mask_value(d, "/layers/a/m1", "space"), Json::Null);
        assert_eq!(mask_value(d, "/layers/a/m1", "attachTransform"), Json::Null);
    });
    // a text layer masks too (Epic 20), and replaces the source: the slot holds one
    attach(&mut d, "/layers/a/m1", "/layers/v", 3.0).unwrap();
    attach(&mut d, "/layers/a/m1", "/layers/t", 1.0).unwrap();
    assert_eq!(masks_of(&d, "/layers/a/m1"), [("t".into(), "m1".into())]);
    assert!(d.tree().at("/layers/v").unwrap().bound_to().is_empty());
}

#[test]
fn mask_attach_with_the_same_source_is_the_edit_of_its_numbers_and_keeps_the_ref() {
    let mut d = doc();
    with_masks(
        &mut d,
        placed("a"),
        &[(
            "r1",
            json!({"x": 5.0, "y": 6.0, "scaleX": 2.0, "scaleY": 1.5, "rotation": 0.4}),
        )],
    );
    is_one_undo_step(&mut d, "Attach Mask", |d| {
        run(
            d,
            "mask.attach",
            json!({"at": "/layers/a/m1", "source": "/layers/v", "featherPx": 8.0,
                   "expand": -1.0, "invert": true, "space": "node",
                   "attachTransform": {"x": 5, "y": 6, "scaleX": 2, "scaleY": 1.5, "rotation": 0.4}}),
        )
        .unwrap();
        // the ref it had, not a new one
        assert_eq!(masks_of(d, "/layers/a/m1"), [("v".into(), "r1".into())]);
        assert_eq!(mask_value(d, "/layers/a/m1", "featherPx"), json!(8.0));
        assert_eq!(mask_value(d, "/layers/a/m1", "space"), json!("node"));
        assert_eq!(attach_of(d, "/layers/a/m1").scale_x, 2.0);
    });
    // a scrub of the feather in a gesture is one step
    let steps = d.tree().history_len();
    let g = d.begin("Edit").unwrap();
    for f in [1.0, 2.0, 3.0] {
        attach(&mut d, "/layers/a/m1", "/layers/v", f).unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
}

#[test]
fn mask_attach_refuses_a_source_that_cannot_mask_and_changes_nothing() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("p", "pixel")).unwrap();
    add(&mut d, node("v", "vector")).unwrap();
    let before = d.tree().serialise();
    for (source, why) in [
        ("/layers/p", "a pixel layer"),
        ("/layers/nope", "a layer that isn't there"),
        ("/layers/a/m1", "a modifier"),
    ] {
        assert!(
            attach(&mut d, "/layers/a/m1", source, 1.0).is_err(),
            "{why}"
        );
    }
    assert!(attach(&mut d, "/layers/a", "/layers/v", 1.0).is_err());
    assert!(run(
        &mut d,
        "mask.attach",
        json!({"at": "/layers/a/m1", "source": "/layers/v", "featherPx": 1.0, "expand": 0.0,
               "invert": false, "space": "sideways"}),
    )
    .is_err());
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn mask_detach_takes_the_binding_and_keeps_the_source_layer() {
    let mut d = doc();
    with_masks(&mut d, placed("a"), &[("r1", Json::Null)]);
    is_one_undo_step(&mut d, "Remove Mask", |d| {
        run(d, "mask.detach", json!({"at": "/layers/a/m1"})).unwrap();
        assert!(masks_of(d, "/layers/a/m1").is_empty());
        assert_eq!(stack(d), ["v", "a"]);
    });
    // no mask, nothing to take
    let steps = d.tree().history_len();
    assert!(run(&mut d, "mask.detach", json!({"at": "/layers/a/m1"})).is_err());
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn mask_set_space_snapshots_the_consumers_transform_or_clears_it() {
    let mut d = doc();
    with_masks(&mut d, placed("a"), &[("r1", Json::Null)]);
    let space = |d: &mut Document<Oblique>, s: &str| {
        run(
            d,
            "mask.set_space",
            json!({"at": "/layers/a/m1", "space": s}),
        )
    };
    is_one_undo_step(&mut d, "Mask Follows Layer", |d| {
        space(d, "node").unwrap();
        assert_eq!(mask_value(d, "/layers/a/m1", "space"), json!("node"));
        near_placement(
            attach_of(d, "/layers/a/m1"),
            Placement {
                x: 100.0,
                y: 40.0,
                scale_x: -1.0,
                scale_y: 1.0,
                rotation: 0.3,
            },
        );
        // the ref and the numbers stay as they were
        assert_eq!(masks_of(d, "/layers/a/m1"), [("v".into(), "r1".into())]);
    });
    // already following: no change, no step
    space(&mut d, "node").unwrap();
    let steps = d.tree().history_len();
    assert_eq!(space(&mut d, "node").unwrap(), Outcome::Nothing);
    assert_eq!(d.tree().history_len(), steps);
    // the layer moves; switching on again after off takes the new transform
    is_one_undo_step(&mut d, "Mask Follows Layer", |d| {
        space(d, "document").unwrap();
        assert_eq!(mask_value(d, "/layers/a/m1", "space"), Json::Null);
        assert_eq!(mask_value(d, "/layers/a/m1", "attachTransform"), Json::Null);
    });
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([7.0, 8.0]),
    )
    .unwrap();
    space(&mut d, "node").unwrap();
    assert_eq!(attach_of(&d, "/layers/a/m1").x, 7.0);
    // document-space already: nothing to do
    space(&mut d, "document").unwrap();
    assert_eq!(space(&mut d, "document").unwrap(), Outcome::Nothing);
    // an unmoved consumer snapshots the identity
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("v", "vector")).unwrap();
    attach(&mut d, "/layers/a/m1", "/layers/v", 0.0).unwrap();
    space(&mut d, "node").unwrap();
    near_placement(attach_of(&d, "/layers/a/m1"), identity());
}

#[test]
fn mask_set_space_refuses_no_mask_and_an_unknown_space() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    let before = d.tree().serialise();
    for s in ["node", "document", "sideways"] {
        assert!(run(
            &mut d,
            "mask.set_space",
            json!({"at": "/layers/a/m1", "space": s})
        )
        .is_err());
    }
    assert_eq!(d.tree().serialise(), before);
}

fn marquee(
    d: &mut Document<Oblique>,
    at: &str,
    id: &str,
    label: &str,
) -> rhizome_pom::Result<Outcome> {
    run(
        d,
        "mask.from_marquee",
        json!({"at": at, "vectorId": id, "label": label, "fillRule": "evenodd",
               "paths": [{"anchors": [{"point": {"x": 1.0, "y": 2.0}}], "closed": true}],
               "featherPx": 4.0, "expand": -2.0, "invert": true}),
    )
}

#[test]
fn mask_from_marquee_makes_the_hidden_layer_and_the_binding_in_one_undo_step() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("b", "pixel")).unwrap();
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([30.0, 40.0]),
    )
    .unwrap();
    is_one_undo_step(&mut d, "Mask from Selection", |d| {
        marquee(d, "/layers/a/m1", "sel", "Selection (rect)").unwrap();
        // on top of the stack, hidden, an image output, as the store's addVectorNode makes it
        assert_eq!(stack(d), ["sel", "b", "a"]);
        assert_eq!(
            value(d, "/layers/sel", "label"),
            Some(Value::Text("Selection (rect)".into()))
        );
        assert_eq!(value(d, "/layers/sel", "visible"), Some(Value::Bool(false)));
        assert_eq!(
            value(d, "/layers/sel", "output"),
            Some(Value::Choice("image".into()))
        );
        assert_eq!(
            value(d, "/layers/sel", "fillRule"),
            Some(Value::Choice("evenodd".into()))
        );
        assert_eq!(
            value(d, "/layers/sel", "state"),
            Some(Value::Choice("active".into()))
        );
        // bound node-pinned, with the consumer's transform now
        assert_eq!(masks_of(d, "/layers/a/m1"), [("sel".into(), "m1".into())]);
        assert_eq!(mask_value(d, "/layers/a/m1", "space"), json!("node"));
        near_placement(
            attach_of(d, "/layers/a/m1"),
            Placement {
                x: 30.0,
                y: 40.0,
                scale_x: 1.0,
                scale_y: 1.0,
                rotation: 0.0,
            },
        );
        assert_eq!(mask_value(d, "/layers/a/m1", "featherPx"), json!(4.0));
        assert_eq!(mask_value(d, "/layers/a/m1", "expand"), json!(-2.0));
        assert_eq!(mask_value(d, "/layers/a/m1", "invert"), json!(true));
    });
}

#[test]
fn the_replace_rule_removes_an_orphaned_selection_layer_in_the_same_step() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    marquee(&mut d, "/layers/a/m1", "s1", "Selection (rect)").unwrap();
    is_one_undo_step(&mut d, "Mask from Selection", |d| {
        marquee(d, "/layers/a/m1", "s2", "Selection (ellipse)").unwrap();
        // the old selection layer went; the mask keeps its ref
        assert_eq!(stack(d), ["s2", "a"]);
        assert!(d.tree().at("/layers/s1").is_none());
        assert_eq!(masks_of(d, "/layers/a/m1"), [("s2".into(), "m1".into())]);
    });
    // the colour and segment tools label theirs their own way
    marquee(&mut d, "/layers/a/m1", "s3", "Selection (colour)").unwrap();
    marquee(&mut d, "/layers/a/m1", "s4", "Selection (segment)").unwrap();
    assert_eq!(stack(&d), ["s4", "a"]);
}

#[test]
fn the_replace_rule_keeps_a_shared_or_user_made_layer() {
    // shared: a second modifier still uses the old selection
    let mut d = doc();
    with_modifiers(&mut d, &["m1", "m2"]);
    marquee(&mut d, "/layers/a/m1", "s1", "Selection (rect)").unwrap();
    attach(&mut d, "/layers/a/m2", "/layers/s1", 0.0).unwrap();
    marquee(&mut d, "/layers/a/m1", "s2", "Selection (rect)").unwrap();
    assert_eq!(stack(&d), ["s2", "s1", "a"]);
    assert_eq!(masks_of(&d, "/layers/a/m2"), [("s1".into(), "m2".into())]);

    // user-made: a layer whose label isn't ours
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    let mut shape = node("shape", "vector");
    shape["label"] = json!("My shape");
    add(&mut d, shape).unwrap();
    attach(&mut d, "/layers/a/m1", "/layers/shape", 0.0).unwrap();
    marquee(&mut d, "/layers/a/m1", "s1", "Selection (rect)").unwrap();
    assert_eq!(stack(&d), ["s1", "shape", "a"]);
    assert_eq!(masks_of(&d, "/layers/a/m1"), [("s1".into(), "m1".into())]);

    // a first mask has nothing to replace
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    add(&mut d, node("other", "vector")).unwrap();
    marquee(&mut d, "/layers/a/m1", "s1", "Selection (rect)").unwrap();
    assert_eq!(stack(&d), ["s1", "other", "a"]);
}

#[test]
fn mask_from_marquee_refuses_a_taken_id_and_a_bad_target_and_changes_nothing() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    assert!(marquee(&mut d, "/layers/a/m1", "a", "Selection (rect)").is_err());
    assert!(marquee(&mut d, "/layers/a", "s1", "Selection (rect)").is_err());
    assert!(marquee(&mut d, "/layers/a/nope", "s1", "Selection (rect)").is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn removing_the_mask_layer_after_a_marquee_prunes_the_binding() {
    let mut d = doc();
    with_modifiers(&mut d, &["m1"]);
    marquee(&mut d, "/layers/a/m1", "s1", "Selection (rect)").unwrap();
    remove(&mut d, "/layers/s1").unwrap();
    assert!(masks_of(&d, "/layers/a/m1").is_empty());
    d.undo().unwrap();
    assert_eq!(masks_of(&d, "/layers/a/m1"), [("s1".into(), "m1".into())]);
}

/// Every op in the sidecar's real catalogue: `modifier.add` stores each param as the
/// catalogue's default, and an int default arrives as an int. Opt-in: needs `uv`.
#[test]
#[ignore = "reads the sidecar's real catalogue through uv"]
fn modifier_add_stores_the_real_catalogues_defaults() {
    let cx = real_catalogue();
    let mut d =
        Document::<Oblique>::new_in(cx.clone(), MemoryStore::default(), IdSource::sequential())
            .unwrap();
    add(&mut d, node("a", "pixel")).unwrap();
    for (i, op) in cx.0.iter().enumerate() {
        let id = format!("m{i}");
        run(
            &mut d,
            "modifier.add",
            json!({"at": "/layers/a", "id": id, "type": op.name}),
        )
        .unwrap_or_else(|e| panic!("{}: {e}", op.name));
        let n = d.tree().at(format!("/layers/a/{id}").as_str()).unwrap();
        for p in &op.params {
            let key = super::param_key(&p.name);
            let got = n.value(&key).unwrap().to_json();
            let want = match p.kind.as_str() {
                "float" | "int" => json!(p.default.as_f64().unwrap()),
                _ => p.default.clone(),
            };
            assert_eq!(
                got.as_f64().map(|f| json!(f)).unwrap_or(got.clone()),
                want,
                "{}.{}",
                op.name,
                p.name
            );
            assert!(n.is_set(&key), "{}.{}", op.name, p.name);
        }
    }
}

#[test]
fn the_updates_name_the_rows_the_webview_applies() {
    // The webview's echo works from the rows an update carries: a modifier row for a value or
    // a mask, the layer row for a changed order, and the removed row for a removal.
    let mut d = doc();
    with_modifiers(&mut d, &["m1", "m2"]);
    add(&mut d, node("v", "vector")).unwrap();
    let rows = |d: &mut Document<Oblique>, id: &str, args: Json| {
        let Outcome::Committed(c) = run(d, id, args).unwrap() else {
            panic!("{id}: not committed")
        };
        let patch = d.tree().patch(&c.changes);
        let mut paths: Vec<String> = patch.rows.iter().map(|r| r.path.to_string()).collect();
        paths.sort();
        (paths, patch.removed.len())
    };
    let (paths, removed) = rows(
        &mut d,
        "modifier.add",
        json!({"at": "/layers/a", "id": "m3", "type": "blur"}),
    );
    assert_eq!(paths, ["/layers/a", "/layers/a/m3"]);
    assert_eq!(removed, 0);
    let (paths, _) = rows(
        &mut d,
        "modifier.set",
        json!({"at": "/layers/a/m1", "key": "params.radius", "value": 9.0}),
    );
    assert_eq!(paths, ["/layers/a/m1"]);
    let (paths, _) = rows(
        &mut d,
        "mask.attach",
        json!({"at": "/layers/a/m1", "source": "/layers/v", "featherPx": 1.0,
               "expand": 0.0, "invert": false}),
    );
    assert_eq!(paths, ["/layers/a/m1"]);
    let (paths, _) = rows(
        &mut d,
        "modifier.reorder",
        json!({"at": "/layers/a/m3", "to": 0}),
    );
    assert_eq!(paths, ["/layers/a"]);
    let (paths, removed) = rows(&mut d, "modifier.remove", json!({"at": "/layers/a/m2"}));
    assert_eq!(paths, ["/layers/a"]);
    assert_eq!(removed, 1);
}

// ---- vectors and text: vector.set_paths, vector.set_fill_rule, text.to_outlines ----

fn two_paths() -> Json {
    json!([
        {"anchors": [
            {"point": {"x": 0.0, "y": 0.0}, "handleOut": {"x": 4.0, "y": 0.0}},
            {"point": {"x": 10.0, "y": 0.0}, "handleIn": {"x": 6.0, "y": 0.0}},
            {"point": {"x": 5.0, "y": 8.0}},
        ], "closed": true},
        {"anchors": [{"point": {"x": 20.0, "y": 20.0}}, {"point": {"x": 30.0, "y": 25.0}}],
         "closed": false},
    ])
}

fn set_paths(d: &mut Document<Oblique>, at: &str, paths: Json) -> rhizome_pom::Result<Outcome> {
    run(d, "vector.set_paths", json!({"at": at, "paths": paths}))
}

fn set_fill_rule(d: &mut Document<Oblique>, at: &str, rule: &str) -> rhizome_pom::Result<Outcome> {
    run(
        d,
        "vector.set_fill_rule",
        json!({"at": at, "fillRule": rule}),
    )
}

fn json_of(d: &Document<Oblique>, at: &str, key: &str) -> Json {
    value(d, at, key).unwrap().to_json()
}

#[test]
fn vector_set_paths_replaces_the_paths_in_one_undo_step_named_edit_path() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    is_one_undo_step(&mut d, "Edit Path", |d| {
        set_paths(d, "/layers/v", two_paths()).unwrap();
        assert_eq!(json_of(d, "/layers/v", "paths"), two_paths());
        // nothing else changes
        assert_eq!(
            value(d, "/layers/v", "fillRule"),
            Some(Value::Choice("nonzero".into()))
        );
    });
}

#[test]
fn a_path_drag_inside_a_gesture_is_one_undo_step() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    let steps = d.tree().history_len();
    let before = d.tree().serialise();
    let g = d.begin("Edit").unwrap();
    for x in 1..=8 {
        let mut paths = two_paths();
        paths[0]["anchors"][0]["point"]["x"] = json!(x as f64);
        set_paths(&mut d, "/layers/v", paths).unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    // the last frame won
    assert_eq!(
        json_of(&d, "/layers/v", "paths")[0]["anchors"][0]["point"]["x"],
        8.0
    );
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before, "one undo takes back the drag");
}

#[test]
fn vector_set_fill_rule_writes_the_rule_in_one_undo_step_named_fill_rule() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    is_one_undo_step(&mut d, "Fill Rule", |d| {
        set_fill_rule(d, "/layers/v", "evenodd").unwrap();
        assert_eq!(
            value(d, "/layers/v", "fillRule"),
            Some(Value::Choice("evenodd".into()))
        );
        // the paths are untouched
        assert_eq!(json_of(d, "/layers/v", "paths")[0]["closed"], false);
    });
}

#[test]
fn the_vector_commands_refuse_a_locked_layer_a_non_vector_and_bad_values_changing_nothing() {
    let mut d = doc();
    let mut shape = node("v", "vector");
    shape["modifiers"] = json!([{"id": "m1", "type": "blur", "enabled": true, "params": {}}]);
    add(&mut d, shape).unwrap();
    add(&mut d, node("locked", "vector")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    add(&mut d, node("p", "pixel")).unwrap();
    lock(&mut d, "/layers/locked");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();

    // locked: the paths and the fill rule are cook inputs, so both are guarded
    let e = set_paths(&mut d, "/layers/locked", two_paths()).unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    let e = set_fill_rule(&mut d, "/layers/locked", "evenodd").unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    // not a vector layer, or not a layer at all
    for at in [
        "/layers/t",
        "/layers/p",
        "/layers/v/m1",
        "/layers",
        "/layers/zzz",
    ] {
        assert!(set_paths(&mut d, at, two_paths()).is_err(), "{at}");
        assert!(set_fill_rule(&mut d, at, "evenodd").is_err(), "{at}");
    }
    // a value that does not fit
    for bad in [
        json!([{"anchors": 3, "closed": true}]),
        json!([{"anchors": [{"point": {"x": 1.0}}], "closed": true}]),
        json!([{"anchors": []}]),
    ] {
        assert!(
            set_paths(&mut d, "/layers/v", bad.clone()).is_err(),
            "{bad}"
        );
    }
    assert!(set_fill_rule(&mut d, "/layers/v", "winding").is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);

    // unlocking lets the same edits through
    unlock(&mut d, "/layers/locked");
    set_paths(&mut d, "/layers/locked", two_paths()).unwrap();
    set_fill_rule(&mut d, "/layers/locked", "evenodd").unwrap();
}

#[test]
fn a_path_edit_names_the_vector_row_for_the_webview() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    for (id, args) in [
        (
            "vector.set_paths",
            json!({"at": "/layers/v", "paths": two_paths()}),
        ),
        (
            "vector.set_fill_rule",
            json!({"at": "/layers/v", "fillRule": "evenodd"}),
        ),
    ] {
        let Outcome::Committed(c) = run(&mut d, id, args).unwrap() else {
            panic!("{id}: not committed")
        };
        let patch = d.tree().patch(&c.changes);
        let rows: Vec<String> = patch.rows.iter().map(|r| r.path.to_string()).collect();
        assert_eq!(rows, ["/layers/v"], "{id}");
        assert!(patch.removed.is_empty(), "{id}");
    }
}

fn outlines(
    d: &mut Document<Oblique>,
    at: &str,
    id: &str,
    paths: Json,
) -> rhizome_pom::Result<Outcome> {
    run(
        d,
        "text.to_outlines",
        json!({"at": at, "id": id, "paths": paths}),
    )
}

fn bind_mask(d: &mut Document<Oblique>, at: &str, source: &str, refid: &str, feather: f64) {
    d.edit("Mask", |tx| {
        tx.bind(
            at,
            On::slot("mask"),
            source,
            [
                ("refId", Value::Text(refid.into())),
                ("featherPx", Value::Float(feather)),
                ("expand", Value::Float(1.5)),
                ("invert", Value::Bool(true)),
                ("space", Value::Shaped(json!("node"))),
                (
                    "attachTransform",
                    Value::Shaped(
                        json!({"x": 5.0, "y": 6.0, "scaleX": 2.0, "scaleY": 1.5, "rotation": 0.4}),
                    ),
                ),
            ],
        )
    })
    .unwrap();
}

fn with_blur(mut n: Json, ids: &[&str]) -> Json {
    n["modifiers"] = json!(ids
        .iter()
        .map(|id| json!({"id": id, "type": "blur", "enabled": true, "params": {"radius": 12.0}}))
        .collect::<Vec<_>>());
    n
}

/// A stack of `top`, the text `t`, `v`, `c` and `bottom` (top first). The text has two
/// modifiers, `t1` masked by the vector `v`; `c` has `c1` and `c2`, both masked by the text.
fn outline_scene() -> Document<Oblique> {
    let mut d = doc();
    add(&mut d, node("bottom", "pixel")).unwrap();
    add(&mut d, with_blur(node("c", "pixel"), &["c1", "c2"])).unwrap();
    add(&mut d, node("v", "vector")).unwrap();
    let mut t = with_blur(node("t", "text"), &["t1", "t2"]);
    t["label"] = json!("Hello");
    t["output"] = json!("mask");
    t["visible"] = json!(false);
    t["blendMode"] = json!("multiply");
    t["opacity"] = json!(0.5);
    t["transform2d"] = json!({"x": 3.0, "y": 4.0, "scaleX": 2.0, "scaleY": 3.0, "rotation": 0.5});
    add(&mut d, t).unwrap();
    add(&mut d, node("top", "pixel")).unwrap();
    bind_mask(&mut d, "/layers/t/t1", "/layers/v", "tr", 3.0);
    bind_mask(&mut d, "/layers/c/c1", "/layers/t", "cr1", 2.0);
    bind_mask(&mut d, "/layers/c/c2", "/layers/t", "cr2", 0.5);
    d
}

#[test]
fn convert_to_outlines_replaces_the_text_in_place_with_a_vector_in_one_undo_step() {
    let mut d = outline_scene();
    assert_eq!(stack(&d), ["top", "t", "v", "c", "bottom"]);
    is_one_undo_step(&mut d, "Convert to Outlines", |d| {
        outlines(d, "/layers/t", "o", two_paths()).unwrap();
        // the same place in the stack, and the text is gone
        assert_eq!(stack(d), ["top", "o", "v", "c", "bottom"]);
        assert!(d.tree().at("/layers/t").is_none());
        let o = d.tree().at("/layers/o").unwrap();
        assert_eq!(o.type_name(), "vector");
        // geometry, nonzero, active
        assert_eq!(json_of(d, "/layers/o", "paths"), two_paths());
        assert_eq!(
            value(d, "/layers/o", "fillRule"),
            Some(Value::Choice("nonzero".into()))
        );
        assert_eq!(
            value(d, "/layers/o", "state"),
            Some(Value::Choice("active".into()))
        );
        // what carries over
        assert_eq!(
            value(d, "/layers/o", "label"),
            Some(Value::Text("Hello".into()))
        );
        assert_eq!(
            value(d, "/layers/o", "output"),
            Some(Value::Choice("mask".into()))
        );
        assert_eq!(value(d, "/layers/o", "visible"), Some(Value::Bool(false)));
        assert_eq!(
            value(d, "/layers/o", "blendMode"),
            Some(Value::Choice("multiply".into()))
        );
        assert_eq!(value(d, "/layers/o", "opacity"), Some(Value::Float(0.5)));
        near_placement(
            placement(d, "/layers/o"),
            Placement {
                x: 3.0,
                y: 4.0,
                scale_x: 2.0,
                scale_y: 3.0,
                rotation: 0.5,
            },
        );
    });
}

#[test]
fn convert_to_outlines_moves_the_modifiers_with_their_ids_order_values_and_masks() {
    let mut d = outline_scene();
    outlines(&mut d, "/layers/t", "o", two_paths()).unwrap();
    assert_eq!(modifier_names(&d, "/layers/o"), ["t1", "t2"]);
    assert!(d.tree().at("/layers/t/t1").is_none());
    assert_eq!(
        value(&d, "/layers/o/t1", "params.radius"),
        Some(Value::Float(12.0))
    );
    // the text's own modifier is still masked by `v`, with the same ref and values
    assert_eq!(masks_of(&d, "/layers/o/t1"), [("v".into(), "tr".into())]);
    assert_eq!(mask_value(&d, "/layers/o/t1", "featherPx"), json!(3.0));
    assert_eq!(mask_value(&d, "/layers/o/t1", "space"), json!("node"));
    assert!(d.tree().at("/layers/o/t2").unwrap().bindings().is_empty());
}

#[test]
fn convert_to_outlines_repoints_every_binding_sourced_from_the_text() {
    let mut d = outline_scene();
    is_one_undo_step(&mut d, "Convert to Outlines", |d| {
        outlines(d, "/layers/t", "o", two_paths()).unwrap();
        // same refs, same values, a new source
        assert_eq!(masks_of(d, "/layers/c/c1"), [("o".into(), "cr1".into())]);
        assert_eq!(masks_of(d, "/layers/c/c2"), [("o".into(), "cr2".into())]);
        for (m, feather) in [("c1", 2.0), ("c2", 0.5)] {
            let at = format!("/layers/c/{m}");
            assert_eq!(mask_value(d, &at, "featherPx"), json!(feather));
            assert_eq!(mask_value(d, &at, "expand"), json!(1.5));
            assert_eq!(mask_value(d, &at, "invert"), json!(true));
            assert_eq!(mask_value(d, &at, "space"), json!("node"));
            assert_eq!(
                attach_of(d, &at),
                Placement {
                    x: 5.0,
                    y: 6.0,
                    scale_x: 2.0,
                    scale_y: 1.5,
                    rotation: 0.4
                }
            );
        }
        // and what the vector layer is the source of is reachable from it
        let o = d.tree().at("/layers/o").unwrap();
        let from_o: Vec<String> = o
            .bound_to()
            .iter()
            .map(|b| b.target.path().to_string())
            .collect();
        assert_eq!(from_o, ["/layers/c/c1", "/layers/c/c2"]);
    });
    // undo brings the text back with every binding pointing at it again, redo undoes that
    d.undo().unwrap();
    assert_eq!(masks_of(&d, "/layers/c/c1"), [("t".into(), "cr1".into())]);
    assert_eq!(masks_of(&d, "/layers/c/c2"), [("t".into(), "cr2".into())]);
    assert_eq!(masks_of(&d, "/layers/t/t1"), [("v".into(), "tr".into())]);
    assert_eq!(modifier_names(&d, "/layers/t"), ["t1", "t2"]);
    assert_eq!(stack(&d), ["top", "t", "v", "c", "bottom"]);
    d.redo().unwrap();
    assert_eq!(masks_of(&d, "/layers/c/c1"), [("o".into(), "cr1".into())]);
}

#[test]
fn convert_to_outlines_keeps_a_text_layer_that_was_never_moved_unmoved() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    outlines(&mut d, "/layers/t", "o", two_paths()).unwrap();
    let o = d.tree().at("/layers/o").unwrap();
    // the store carries `transform2d` only when it is set
    assert!(!o.is_set("transform2d.position"));
    assert!(!o.is_set("transform2d.scale"));
    assert!(!o.is_set("transform2d.rotation"));
    assert_eq!(stack(&d), ["o"]);
}

#[test]
fn convert_to_outlines_masks_by_a_text_layers_own_modifier_survive_when_it_masks_itself() {
    // a text layer's modifier masked by the text layer itself: the binding's source moves with it
    let mut d = doc();
    add(&mut d, with_blur(node("t", "text"), &["t1"])).unwrap();
    bind_mask(&mut d, "/layers/t/t1", "/layers/t", "self", 1.0);
    is_one_undo_step(&mut d, "Convert to Outlines", |d| {
        outlines(d, "/layers/t", "o", two_paths()).unwrap();
        assert_eq!(masks_of(d, "/layers/o/t1"), [("o".into(), "self".into())]);
    });
}

#[test]
fn convert_to_outlines_updates_name_the_rows_the_webview_applies() {
    let mut d = outline_scene();
    let Outcome::Committed(c) = outlines(&mut d, "/layers/t", "o", two_paths()).unwrap() else {
        panic!("not committed")
    };
    let patch = d.tree().patch(&c.changes);
    let mut rows: Vec<String> = patch.rows.iter().map(|r| r.path.to_string()).collect();
    rows.sort();
    // the new layer, the modifiers under their new parent, the consumers' re-pointed modifiers
    // and the stack; the text is the one row removed
    for want in [
        "/layers",
        "/layers/o",
        "/layers/o/t1",
        "/layers/o/t2",
        "/layers/c/c1",
        "/layers/c/c2",
    ] {
        assert!(rows.contains(&want.to_string()), "{want} in {rows:?}");
    }
    assert!(!rows.iter().any(|r| r.starts_with("/layers/t")), "{rows:?}");
    // the text layer's row goes; the moved modifiers do not (they keep their rows)
    assert_eq!(patch.removed.len(), 1);
    let o = patch
        .rows
        .iter()
        .find(|r| r.path.to_string() == "/layers/o")
        .unwrap();
    let moved = patch
        .rows
        .iter()
        .find(|r| r.path.to_string() == "/layers/o/t1")
        .unwrap();
    assert_eq!(moved.parent, Some(o.id.clone()));
    for r in patch
        .rows
        .iter()
        .filter(|r| r.path.to_string().starts_with("/layers/c/"))
    {
        assert_eq!(r.bindings.len(), 1);
        assert_eq!(r.bindings[0].source, o.id);
    }
}

#[test]
fn convert_to_outlines_refuses_a_locked_text_a_non_text_a_taken_id_and_bad_paths() {
    let mut d = outline_scene();
    add(&mut d, node("locked", "text")).unwrap();
    lock(&mut d, "/layers/locked");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    let e = outlines(&mut d, "/layers/locked", "o", two_paths()).unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    for at in [
        "/layers/v",
        "/layers/c",
        "/layers/t/t1",
        "/layers",
        "/layers/zzz",
    ] {
        assert!(outlines(&mut d, at, "o", two_paths()).is_err(), "{at}");
    }
    // an id a layer already has
    assert!(outlines(&mut d, "/layers/t", "v", two_paths()).is_err());
    assert!(outlines(&mut d, "/layers/t", "t", two_paths()).is_err());
    // paths that do not fit
    assert!(outlines(&mut d, "/layers/t", "o", json!([{"anchors": 3}])).is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn a_converted_document_saves_and_opens_with_its_bindings_intact() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    for (id, n) in [
        ("bottom", node("bottom", "pixel")),
        ("c", with_blur(node("c", "pixel"), &["c1"])),
        ("t", with_blur(node("t", "text"), &["t1"])),
    ] {
        add(&mut d, n).unwrap_or_else(|e| panic!("{id}: {e}"));
    }
    bind_mask(&mut d, "/layers/c/c1", "/layers/t", "cr", 2.0);
    outlines(&mut d, "/layers/t", "o", two_paths()).unwrap();
    d.save_as("/mem/outlined").unwrap();
    let (back, report) = Document::<Oblique>::open_in(
        catalogue(),
        store,
        "/mem/outlined.oblique",
        IdSource::sequential(),
    )
    .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(back.tree().serialise(), d.tree().serialise());
    assert_eq!(masks_of(&back, "/layers/c/c1"), [("o".into(), "cr".into())]);
    assert_eq!(modifier_names(&back, "/layers/o"), ["t1"]);
}

// ---- document and lock: document.set_background, document.set_note, layer.set_state ----

const DOC: &str = "/document/document";

fn background(d: &mut Document<Oblique>, b: Json) -> rhizome_pom::Result<Outcome> {
    run(d, "document.set_background", json!({ "background": b }))
}

fn colour(c: &str) -> Json {
    json!({"type": "color", "color": c})
}

fn image(path: &str) -> Json {
    json!({"type": "image", "sourcePath": path, "sourceSize": [60.0, 40.0]})
}

fn stored_background(d: &Document<Oblique>) -> Option<Json> {
    let n = d.tree().at(DOC).unwrap();
    n.is_set("background")
        .then(|| json_of(d, DOC, "background"))
}

#[test]
fn set_background_writes_a_colour_in_one_undo_step_named_background() {
    let mut d = doc();
    assert_eq!(stored_background(&d), None);
    is_one_undo_step(&mut d, "Background", |d| {
        background(d, colour("#ff8800")).unwrap();
        assert_eq!(stored_background(d), Some(colour("#ff8800")));
    });
}

#[test]
fn set_background_walks_colour_image_none_and_undo_goes_back_through_each() {
    let mut d = doc();
    background(&mut d, colour("#112233")).unwrap();
    background(&mut d, image("/pics/bg.png")).unwrap();
    background(&mut d, Json::Null).unwrap();
    assert_eq!(d.tree().history_len(), 3);
    assert_eq!(
        stored_background(&d),
        None,
        "none is unset, not a stored null"
    );

    d.undo().unwrap();
    assert_eq!(stored_background(&d), Some(image("/pics/bg.png")));
    d.undo().unwrap();
    assert_eq!(stored_background(&d), Some(colour("#112233")));
    d.undo().unwrap();
    assert_eq!(stored_background(&d), None);
    d.redo().unwrap();
    d.redo().unwrap();
    d.redo().unwrap();
    assert_eq!(stored_background(&d), None);
    assert_eq!(d.tree().undo_label(), Some("Background"));
}

#[test]
fn set_background_to_what_it_already_is_is_not_a_step() {
    let mut d = doc();
    background(&mut d, Json::Null).unwrap(); // none, and none already
    assert_eq!(d.tree().history_len(), 0);
    background(&mut d, colour("#112233")).unwrap();
    let steps = d.tree().history_len();
    let before = d.tree().serialise();
    background(&mut d, colour("#112233")).unwrap();
    assert_eq!(d.tree().history_len(), steps);
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn set_background_keeps_one_shape_so_equal_backgrounds_are_equal_trees() {
    let mut d = doc();
    // a colour never carries image fields, nor an image a colour: the store writes neither
    for bad in [
        json!({"type": "color", "color": "#fff", "sourcePath": "/x.png"}),
        json!({"type": "color"}),
        json!({"type": "color", "color": 3}),
        json!({"type": "image", "sourcePath": "/x.png"}),
        json!({"type": "image", "sourcePath": "/x.png", "sourceSize": [1.0]}),
        json!({"type": "image", "sourcePath": "/x.png", "sourceSize": [1.0, "a"]}),
        json!({"type": "image", "sourcePath": "/x.png", "sourceSize": [1.0, 2.0], "color": "#fff"}),
        json!({"type": "gradient"}),
        json!({"color": "#fff"}),
        json!("#fff"),
        json!([1.0]),
    ] {
        assert!(background(&mut d, bad.clone()).is_err(), "{bad}");
    }
    assert_eq!(d.tree().history_len(), 0);
    assert_eq!(stored_background(&d), None);
    // the key has to be there, even to say none
    assert!(!d.is_enabled("document.set_background", &json!({})).unwrap());
    assert!(d.run("document.set_background", &json!({})).is_err());
}

#[test]
fn a_colour_drag_inside_a_gesture_is_one_undo_step() {
    let mut d = doc();
    background(&mut d, colour("#000000")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    let g = d.begin("Edit").unwrap();
    for c in ["#101010", "#202020", "#303030", "#404040"] {
        background(&mut d, colour(c)).unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(stored_background(&d), Some(colour("#404040")));
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn set_note_writes_and_clears_it_in_steps_named_edit_note() {
    let mut d = doc();
    let note = |d: &mut Document<Oblique>, n: &str| run(d, "document.set_note", json!({"note": n}));
    let stored = |d: &Document<Oblique>| {
        d.tree()
            .at(DOC)
            .unwrap()
            .is_set("note")
            .then(|| value(d, DOC, "note"))
    };
    assert_eq!(stored(&d), None);
    is_one_undo_step(&mut d, "Edit Note", |d| {
        note(d, "for the poster").unwrap();
        assert_eq!(
            value(d, DOC, "note"),
            Some(Value::Text("for the poster".into()))
        );
    });
    note(&mut d, "for the poster").unwrap();
    // an empty note removes the value, so a saved file stays clean
    is_one_undo_step(&mut d, "Edit Note", |d| {
        note(d, "").unwrap();
        assert_eq!(stored(d), None);
    });
    // empty over nothing, and the same note again, are no step
    let steps = d.tree().history_len();
    note(&mut d, "").unwrap();
    assert_eq!(d.tree().history_len(), steps);
    note(&mut d, "x").unwrap();
    let steps = d.tree().history_len();
    note(&mut d, "x").unwrap();
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn typing_a_note_inside_a_gesture_is_one_undo_step_and_undo_clears_it() {
    let mut d = doc();
    let before = d.tree().serialise();
    let g = d.begin("Edit").unwrap();
    for n in ["h", "he", "hel", "hello"] {
        run(&mut d, "document.set_note", json!({"note": n})).unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), 1);
    assert_eq!(value(&d, DOC, "note"), Some(Value::Text("hello".into())));
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before);
    assert!(!d.tree().at(DOC).unwrap().is_set("note"));
}

#[test]
fn set_note_refuses_what_is_not_text() {
    let mut d = doc();
    for bad in [json!(3), json!(null), json!(["a"])] {
        assert!(run(&mut d, "document.set_note", json!({"note": bad})).is_err());
    }
    assert!(run(&mut d, "document.set_note", json!({})).is_err());
    assert!(!d.is_enabled("document.set_note", &json!({})).unwrap());
    assert_eq!(d.tree().history_len(), 0);
}

fn set_state(d: &mut Document<Oblique>, at: &str, state: &str) -> rhizome_pom::Result<Outcome> {
    run(d, "layer.set_state", json!({"at": at, "state": state}))
}

fn state_of(d: &Document<Oblique>, at: &str) -> Value {
    value(d, at, "state").unwrap()
}

fn locked() -> Value {
    Value::Choice("locked".into())
}

fn active() -> Value {
    Value::Choice("active".into())
}

#[test]
fn lock_and_unlock_are_one_undo_step_each_and_named_for_what_they_do() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("b", "pixel")).unwrap();
    is_one_undo_step(&mut d, "Lock Layer", |d| {
        set_state(d, "/layers/a", "locked").unwrap();
        assert_eq!(state_of(d, "/layers/a"), locked());
    });
    set_state(&mut d, "/layers/a", "locked").unwrap();
    is_one_undo_step(&mut d, "Unlock Layer", |d| {
        set_state(d, "/layers/a", "active").unwrap();
        assert_eq!(state_of(d, "/layers/a"), active());
    });
    assert_eq!(
        state_of(&d, "/layers/b"),
        active(),
        "the others are left alone"
    );
}

#[test]
fn undo_of_an_unlock_relocks_and_redo_of_a_lock_locks_again() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    unlock(&mut d, "/layers/a");
    d.undo().unwrap();
    assert_eq!(state_of(&d, "/layers/a"), locked());
    d.undo().unwrap();
    assert_eq!(state_of(&d, "/layers/a"), active());
    d.redo().unwrap();
    assert_eq!(state_of(&d, "/layers/a"), locked());
    // and a locked layer refuses what the lock guards, until it is unlocked
    assert!(set(&mut d, "/layers/a", "transform2d.rotation", json!(1.0)).is_err());
    unlock(&mut d, "/layers/a");
    set(&mut d, "/layers/a", "transform2d.rotation", json!(1.0)).unwrap();
}

#[test]
fn every_layer_kind_can_be_locked_and_unlocked() {
    let mut d = doc();
    for kind in ["pixel", "vector", "text"] {
        add(&mut d, node(kind, kind)).unwrap();
        let at = format!("/layers/{kind}");
        set_state(&mut d, &at, "locked").unwrap();
        assert_eq!(state_of(&d, &at), locked(), "{kind}");
        set_state(&mut d, &at, "active").unwrap();
        assert_eq!(state_of(&d, &at), active(), "{kind}");
    }
}

#[test]
fn locking_a_layer_in_the_state_it_is_in_is_not_a_step() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let (steps, before) = (d.tree().history_len(), d.tree().serialise());
    set_state(&mut d, "/layers/a", "active").unwrap();
    assert_eq!(
        (d.tree().history_len(), d.tree().serialise()),
        (steps, before)
    );
    lock(&mut d, "/layers/a");
    let (steps, before) = (d.tree().history_len(), d.tree().serialise());
    set_state(&mut d, "/layers/a", "locked").unwrap();
    assert_eq!(
        (d.tree().history_len(), d.tree().serialise()),
        (steps, before)
    );
}

#[test]
fn set_state_refuses_what_is_not_a_layer_or_not_a_state_and_changes_nothing() {
    let mut d = doc();
    with_modifiers(&mut d, &["m"]);
    let (steps, before) = (d.tree().history_len(), d.tree().serialise());
    for (at, state) in [
        ("/layers/a", "baking"),
        ("/layers/a", ""),
        ("/layers/a/m", "locked"),
        ("/layers", "locked"),
        ("/document/document", "locked"),
        ("/layers/zzz", "locked"),
    ] {
        assert!(set_state(&mut d, at, state).is_err(), "{at} {state}");
    }
    assert!(run(&mut d, "layer.set_state", json!({"at": "/layers/a"})).is_err());
    assert!(!d.is_enabled("layer.set_state", &json!({})).unwrap());
    assert_eq!(
        (d.tree().history_len(), d.tree().serialise()),
        (steps, before)
    );
}

#[test]
fn the_state_change_names_the_layer_row_the_webview_applies() {
    // The webview unlocks from the layer row an update carries (`state` active).
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    let Outcome::Committed(c) = set_state(&mut d, "/layers/a", "active").unwrap() else {
        panic!("not committed")
    };
    let patch = d.tree().patch(&c.changes);
    let rows: Vec<_> = patch.rows.iter().map(|r| r.path.to_string()).collect();
    assert_eq!(rows, ["/layers/a"]);
}

#[test]
fn background_note_and_lock_survive_a_save_and_open() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    background(&mut d, image("/pics/bg.png")).unwrap();
    run(&mut d, "document.set_note", json!({"note": "for Ana"})).unwrap();
    d.save_as("/mem/kept").unwrap();
    let (back, report) = Document::<Oblique>::open_in(
        catalogue(),
        store,
        "/mem/kept.oblique",
        IdSource::sequential(),
    )
    .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(back.tree().serialise(), d.tree().serialise());
    assert_eq!(stored_background(&back), Some(image("/pics/bg.png")));
    assert_eq!(
        value(&back, DOC, "note"),
        Some(Value::Text("for Ana".into()))
    );
    assert_eq!(state_of(&back, "/layers/a"), locked());
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
        label: None,
        description: None,
        category: None,
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

// ---- the document host as app-kit's History and Document (Epic 22, slice a) ----

/// What the mock app heard: (event name, payload JSON), in order.
type Heard = Arc<Mutex<Vec<(String, String)>>>;

/// A mock app, listening to everything the host and rhizome's transport emit.
fn app_hearing() -> (tauri::App<MockRuntime>, Heard) {
    let app = mock_app();
    let heard = Heard::default();
    for name in [
        "pom://commit",
        "pom://status",
        HISTORY_STEPPED,
        DOCUMENT_OPENED,
        DOCUMENT_SAVED,
        NOTE_EVENT,
    ] {
        let heard = heard.clone();
        app.listen_any(name, move |e| {
            heard
                .lock()
                .unwrap()
                .push((name.to_string(), e.payload().to_string()));
        });
    }
    (app, heard)
}

fn names(heard: &Heard) -> Vec<String> {
    heard
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect()
}

/// The payload of the one event called `name`.
fn payload(heard: &Heard, name: &str) -> Json {
    let all = heard.lock().unwrap();
    let mut it = all.iter().filter(|(n, _)| n == name);
    let (_, p) = it.next().unwrap_or_else(|| panic!("no {name} event"));
    assert!(it.next().is_none(), "more than one {name} event");
    serde_json::from_str(p).unwrap()
}

/// A host with its document, over a store.
fn ready(store: &MemoryStore) -> (DocumentHost, PomHost) {
    let host = DocumentHost::new();
    let transport = host.init(pom(store)).expect("first init");
    (host, transport)
}

fn has_layer(transport: &PomHost, id: &str) -> bool {
    let at = format!("/layers/{id}");
    transport
        .host()
        .view()
        .rows
        .iter()
        .any(|r| r.path.to_string() == at)
}

fn add_layer(transport: &PomHost, id: &str) {
    transport
        .host()
        .run("layer.add", &json!({ "node": node(id, "pixel") }), None)
        .unwrap();
}

#[test]
fn the_document_host_shares_its_pom_with_the_transports_host() {
    let (document, transport) = ready(&MemoryStore::default());
    let told = Arc::new(AtomicU32::new(0));
    let seen = told.clone();
    document.on_change(move || {
        seen.fetch_add(1, Ordering::SeqCst);
    });

    // a command through the transport's host (what `pom_run` calls) ...
    add_layer(&transport, "a");

    // ... is in the document the host reads, and the hook heard of it
    assert!(has_layer(&transport, "a"));
    assert_eq!(told.load(Ordering::SeqCst), 1);
}

#[test]
fn before_init_the_document_is_untitled_and_saved_with_nothing_to_undo() {
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();
    assert!(!host.is_ready());
    assert_eq!(host.untitled_number(), 1);
    assert_eq!(host.path(), None);
    assert!(!host.is_unsaved());
    assert_eq!(
        (host.undo_label(), host.redo_label()),
        (None, None),
        "nothing to undo or redo"
    );
    assert!(host.undo_labels().is_empty() && host.redo_labels().is_empty());
    let state = DocumentState::of(&host);
    assert_eq!(
        (state.name.as_str(), state.title.as_str()),
        ("Untitled-1", "Untitled-1")
    );
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!((titles.undo.as_str(), titles.undo_enabled), ("Undo", false));
    assert_eq!((titles.redo.as_str(), titles.redo_enabled), ("Redo", false));

    // undo and redo have nothing to do, and say nothing
    host.undo(app.handle()).unwrap();
    host.redo(app.handle()).unwrap();
    // save and new say the document isn't ready, and change nothing
    assert_eq!(
        host.save(app.handle(), Path::new("/a.oblique")),
        Err(NOT_READY.into())
    );
    assert_eq!(host.new_document(app.handle(), 2), Err(NOT_READY.into()));
    assert_eq!(host.untitled_number(), 1);
    assert!(names(&heard).is_empty());
}

#[test]
fn an_open_before_init_is_held_and_applied_after_it() {
    let store = MemoryStore::default();
    {
        // a saved document to open: one layer, written through a Pom of its own
        let (_, transport) = ready(&store);
        add_layer(&transport, "kept");
        transport
            .host()
            .save_as(Path::new("/held.oblique"))
            .unwrap();
    }
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();

    // before the catalogue: held (the newest request wins), nothing opens, nothing is heard
    host.open(app.handle(), Path::new("/older.oblique"))
        .unwrap();
    host.open(app.handle(), Path::new("/held.oblique")).unwrap();
    assert!(!host.is_ready() && host.path().is_none());
    assert!(names(&heard).is_empty());

    // init alone does not apply it (the transport isn't managed yet) ...
    let transport = host.init(pom(&store)).expect("first init");
    assert!(host.is_ready() && host.path().is_none());
    assert!(names(&heard).is_empty());

    // ... apply_held does, and emits as any open does
    assert_eq!(host.apply_held(app.handle()), Ok(true));
    assert_eq!(host.path(), Some(PathBuf::from("/held.oblique")));
    assert!(!host.is_unsaved());
    assert!(has_layer(&transport, "kept"));
    let heard_names = names(&heard);
    assert!(heard_names.contains(&"pom://status".to_string()));
    assert_eq!(
        heard_names.last().map(String::as_str),
        Some(DOCUMENT_OPENED),
        "document-opened comes after the transport's events"
    );
    assert_eq!(
        payload(&heard, DOCUMENT_OPENED),
        json!({"issues": [], "path": "/held.oblique"})
    );

    // it was held once
    assert_eq!(host.apply_held(app.handle()), Ok(false));
}

#[test]
fn a_held_open_that_fails_leaves_an_untitled_document() {
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();
    host.open(app.handle(), Path::new("/missing.oblique"))
        .unwrap();
    host.init(pom(&MemoryStore::default())).unwrap();
    assert!(host.apply_held(app.handle()).is_err());
    assert!(host.is_ready());
    assert_eq!(host.path(), None);
    assert!(!names(&heard).contains(&DOCUMENT_OPENED.to_string()));
    // the failure is an app-kit note for the webview, in app-kit's own wording
    let note = payload(&heard, NOTE_EVENT);
    let note = note.as_str().expect("a note is a string");
    assert!(
        note.starts_with("\u{201c}missing.oblique\u{201d} couldn't be opened: "),
        "{note}"
    );
    // and it is not held again
    assert_eq!(host.apply_held(app.handle()), Ok(false));
}

#[test]
fn init_fills_the_host_once() {
    let host = DocumentHost::new();
    assert!(host.init(pom(&MemoryStore::default())).is_some());
    assert!(host.init(pom(&MemoryStore::default())).is_none());
}

#[test]
fn an_open_after_init_opens_at_once() {
    let store = MemoryStore::default();
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&store);
    add_layer(&transport, "a");
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    add_layer(&transport, "b");
    assert!(host.is_unsaved());
    heard.lock().unwrap().clear();

    host.open(app.handle(), Path::new("/doc.oblique")).unwrap();
    assert_eq!(host.path(), Some(PathBuf::from("/doc.oblique")));
    assert!(!host.is_unsaved(), "a fresh open is saved");
    assert!(host.undo_labels().is_empty(), "with an empty history");
    assert_eq!(
        payload(&heard, DOCUMENT_OPENED),
        json!({"issues": [], "path": "/doc.oblique"})
    );
}

#[test]
fn undo_and_redo_titles_come_from_the_status() {
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    add_layer(&transport, "a");
    let step = transport.host().status().undo.expect("a step to undo");

    // app-kit's menu titles, read through History from POM's status
    assert_eq!(host.undo_label().as_deref(), Some(step.as_str()));
    assert_eq!(host.undo_labels(), vec![step.clone()]);
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!(titles.undo, format!("Undo {step}"));
    assert!(titles.undo_enabled);
    assert_eq!((titles.redo.as_str(), titles.redo_enabled), ("Redo", false));

    heard.lock().unwrap().clear();
    host.undo(app.handle()).unwrap();
    assert!(!has_layer(&transport, "a"));
    assert_eq!(host.undo_label(), None);
    assert_eq!(host.redo_label().as_deref(), Some(step.as_str()));
    assert_eq!(host.redo_labels(), vec![step.clone()]);
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!(titles.redo, format!("Redo {step}"));
    assert!(titles.redo_enabled && !titles.undo_enabled);

    // rhizome's commit reaches the webview's mirror, then history-stepped, with the bare label
    let heard_names = names(&heard);
    assert_eq!(
        heard_names.last().map(String::as_str),
        Some(HISTORY_STEPPED),
        "{heard_names:?}"
    );
    assert!(heard_names.contains(&"pom://commit".to_string()));
    assert_eq!(
        payload(&heard, HISTORY_STEPPED),
        json!({"undid": true, "label": step})
    );

    heard.lock().unwrap().clear();
    host.redo(app.handle()).unwrap();
    assert!(has_layer(&transport, "a"));
    assert_eq!(host.redo_label(), None);
    assert_eq!(
        payload(&heard, HISTORY_STEPPED),
        json!({"undid": false, "label": step})
    );
}

#[test]
fn undo_with_nothing_to_undo_is_quiet() {
    let (app, heard) = app_hearing();
    let (host, _transport) = ready(&MemoryStore::default());
    host.undo(app.handle()).unwrap();
    host.redo(app.handle()).unwrap();
    assert!(!names(&heard).contains(&HISTORY_STEPPED.to_string()));
}

#[test]
fn unsaved_is_derived_not_flagged() {
    let (app, _heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    assert!(!host.is_unsaved());

    add_layer(&transport, "a");
    assert!(host.is_unsaved());
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    assert!(!host.is_unsaved());
    assert_eq!(host.path(), Some(PathBuf::from("/doc.oblique")));

    add_layer(&transport, "b");
    assert!(host.is_unsaved());
    // back to what is on disk: saved again, without a save
    host.undo(app.handle()).unwrap();
    assert!(!host.is_unsaved());
    host.redo(app.handle()).unwrap();
    assert!(host.is_unsaved());
}

#[test]
fn new_replaces_the_document_and_takes_app_kits_number() {
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    add_layer(&transport, "a");
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    heard.lock().unwrap().clear();

    host.new_document(app.handle(), 2).unwrap();
    assert_eq!(host.untitled_number(), 2);
    assert_eq!(host.path(), None);
    assert!(!host.is_unsaved());
    assert!(host.undo_labels().is_empty());
    let state = DocumentState::of(&host);
    assert_eq!(state.name, "Untitled-2");
    // a new document has no file to say
    assert_eq!(
        payload(&heard, DOCUMENT_OPENED),
        json!({"issues": [], "path": null})
    );
}

#[test]
fn a_save_says_where_it_came_from_and_where_it_went() {
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    add_layer(&transport, "a");

    // the first save of an Untitled document has no previous file
    host.save(app.handle(), Path::new("/a/doc.oblique"))
        .unwrap();
    assert_eq!(
        payload(&heard, DOCUMENT_SAVED),
        json!({"previous": null, "path": "/a/doc.oblique"})
    );
    // rhizome's status events come first, so the webview's path is current when this arrives
    let heard_names = names(&heard);
    assert_eq!(
        heard_names.last().map(String::as_str),
        Some(DOCUMENT_SAVED),
        "{heard_names:?}"
    );
    assert!(heard_names.contains(&"pom://status".to_string()));

    // a plain Save is the same path twice; a Save As moves it
    heard.lock().unwrap().clear();
    host.save(app.handle(), Path::new("/a/doc.oblique"))
        .unwrap();
    assert_eq!(
        payload(&heard, DOCUMENT_SAVED),
        json!({"previous": "/a/doc.oblique", "path": "/a/doc.oblique"})
    );
    heard.lock().unwrap().clear();
    host.save(app.handle(), Path::new("/b/copy.oblique"))
        .unwrap();
    assert_eq!(
        payload(&heard, DOCUMENT_SAVED),
        json!({"previous": "/a/doc.oblique", "path": "/b/copy.oblique"})
    );
}

#[test]
fn the_change_hook_may_be_scheduled_while_the_document_is_locked() {
    // `refresh_on_change` sets the hook; a command runs it under the Pom's lock. It must only
    // queue the refresh, so the command returns (a refresh run inline would lock the Pom
    // again from inside its own lock and hang here).
    let app = mock_app();
    let (host, transport) = ready(&MemoryStore::default());
    host.refresh_on_change(app.handle().clone());
    for id in ["a", "b", "c"] {
        add_layer(&transport, id);
    }
    assert!(host.is_unsaved());
}

// ---- real projects (opt-in) ----

/// The sidecar's op catalogue, as `list_ops` reports it: the JSON file named by
/// `OBLIQUE_OPS` if set, else read from the sidecar's own `OPS` through `uv`. The object model
/// needs it to know the `op.*` kinds a real project holds; an empty one would let those load as
/// unknown nodes and round-trip without proving anything.
fn real_catalogue() -> Arc<Catalogue> {
    let cx = sidecar_catalogue().unwrap_or_else(|e| panic!("{e}"));
    assert!(!cx.0.is_empty(), "an empty op catalogue proves nothing");
    Arc::new(cx)
}

/// The first place two JSON values differ, as a path and both sides.
fn first_difference(a: &Json, b: &Json, at: &str) -> String {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                if x.get(k) != y.get(k) {
                    return match (x.get(k), y.get(k)) {
                        (Some(p), Some(q)) => first_difference(p, q, &format!("{at}.{k}")),
                        (p, q) => format!("{at}.{k}: {p:?} vs {q:?}"),
                    };
                }
            }
            format!("{at}: objects differ")
        }
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
            match x.iter().zip(y).position(|(p, q)| p != q) {
                Some(i) => first_difference(&x[i], &y[i], &format!("{at}[{i}]")),
                None => format!("{at}: lists differ"),
            }
        }
        (Json::Array(x), Json::Array(y)) => format!("{at}: {} vs {} items", x.len(), y.len()),
        _ => format!("{at}: {a} vs {b}"),
    }
}

/// Opens `path` through POM's file store (reading only), saves it to memory, reopens that, and
/// returns the first difference between the two trees. Load issues on either side count.
fn round_trip(cx: &Arc<Catalogue>, path: &str) -> Result<usize, String> {
    let (first, report) = Document::<Oblique>::open_in(cx.clone(), FileStore, path, IdSource::Ulid)
        .map_err(|e| e.to_string())?;
    if !report.issues.is_empty() {
        return Err(format!("open: {:?}", report.issues));
    }
    // what `save_as` would write, kept in memory so the file is never touched
    let memory = MemoryStore::default();
    memory.put("/saved.oblique", &first.tree().serialise());
    let (again, report) =
        Document::<Oblique>::open_in(cx.clone(), memory, "/saved.oblique", IdSource::Ulid)
            .map_err(|e| format!("reopen: {e}"))?;
    if !report.issues.is_empty() {
        return Err(format!("reopen: {:?}", report.issues));
    }
    let rows = |d: &Document<Oblique>| serde_json::to_value(d.tree().rows()).unwrap();
    let (want, got) = (rows(&first), rows(&again));
    if want != got {
        return Err(first_difference(&want, &got, ""));
    }
    if first.tree().serialise() != again.tree().serialise() {
        return Err("the saved text differs after a reopen".into());
    }
    Ok(first.tree().rows().len())
}

/// Every real project opens, saves and reopens to the same tree. Opt-in:
/// `OBLIQUE_FILES="a.oblique:b.oblique" cargo test --lib real_projects -- --ignored --nocapture`
/// (`just coverage "<files>"`). Reads the files and never writes them.
#[test]
#[ignore = "needs OBLIQUE_FILES (colon-separated .oblique files)"]
fn real_projects() {
    let files = std::env::var("OBLIQUE_FILES").expect("OBLIQUE_FILES");
    let files: Vec<&str> = files.split(':').filter(|f| !f.is_empty()).collect();
    assert!(!files.is_empty(), "OBLIQUE_FILES names no files");
    let cx = real_catalogue();
    let mut failed = vec![];
    for f in &files {
        match round_trip(&cx, f) {
            Ok(rows) => eprintln!("ok    {f} ({rows} nodes)"),
            Err(e) => {
                eprintln!("FAIL  {f}: {e}");
                failed.push(f.to_string());
            }
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

#[test]
fn the_round_trip_check_reports_the_first_difference() {
    assert_eq!(
        first_difference(
            &json!({"a": [1, {"b": 2}]}),
            &json!({"a": [1, {"b": 3}]}),
            ""
        ),
        ".a[1].b: 2 vs 3"
    );
    assert_eq!(
        first_difference(&json!({"a": 1}), &json!({"a": 1, "c": 2}), ""),
        ".c: None vs Some(Number(2))"
    );
    assert_eq!(
        first_difference(&json!([1]), &json!([1, 2]), ""),
        ": 1 vs 2 items"
    );
}

// ---- node words (design node-documentation, step 4) ----

/// Two ops, one described by the sidecar and one not: only what the sidecar said may appear.
fn described() -> Document<Oblique> {
    let mut radius = param("radius", "float", json!(5.0), Some(0.0), Some(100.0));
    radius.label = Some("Blur radius".into());
    radius.description = Some("How far each pixel is smeared into its neighbours.".into());
    let mut edge = param("edge", "enum", json!("soft"), None, None);
    // "gone" is no choice of this param: the kind must not panic on it
    edge.choice_labels = [("soft", "Gentle"), ("gone", "Missing")]
        .map(|(c, l)| (c.to_string(), l.to_string()))
        .into();
    let bare = param("amount", "float", json!(1.0), Some(0.0), Some(1.0));
    Document::new_in(
        Arc::new(Catalogue(vec![
            Op {
                name: "gaussian_blur".into(),
                label: Some("Gaussian blur".into()),
                description: Some("Softens the picture evenly.".into()),
                category: Some("distort".into()),
                params: vec![radius, edge],
            },
            Op {
                name: "plain".into(),
                label: None,
                description: None,
                category: None,
                params: vec![bare],
            },
        ])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap()
}

#[test]
fn an_ops_words_reach_its_kind_and_its_params_reach_their_values() {
    let schema = described().tree().registry().schema();
    let ty = |name: &str| schema.types.iter().find(|t| t.name == name).unwrap();
    let blur = ty("op.gaussian_blur");
    assert_eq!(blur.label.as_deref(), Some("Gaussian blur"));
    assert_eq!(blur.summary.as_deref(), Some("Softens the picture evenly."));
    assert_eq!(blur.group.as_deref(), Some("modifier"));
    assert_eq!(blur.category.as_deref(), Some("distort"));
    let radius = blur
        .values
        .iter()
        .find(|v| v.key == "params.radius")
        .unwrap();
    assert_eq!(radius.label.as_deref(), Some("Blur radius"));
    assert_eq!(
        radius.description.as_deref(),
        Some("How far each pixel is smeared into its neighbours.")
    );
    assert_eq!(radius.unit, None, "the sidecar has no units to carry");
    assert!(radius.choice_labels.is_empty());
    let edge = blur.values.iter().find(|v| v.key == "params.edge").unwrap();
    assert_eq!(edge.choices, ["soft", "hard"]);
    assert_eq!(
        edge.choice_labels,
        [("soft".to_string(), "Gentle".to_string())].into(),
        "a label for a choice the param has comes across, and one for a choice it lacks is dropped"
    );
}

#[test]
fn missing_words_stay_unset() {
    let schema = described().tree().registry().schema();
    let plain = schema.types.iter().find(|t| t.name == "op.plain").unwrap();
    assert_eq!(
        (plain.label.as_deref(), plain.summary.as_deref()),
        (None, None)
    );
    assert_eq!(plain.group.as_deref(), Some("modifier"));
    assert_eq!(plain.category, None);
    let amount = plain
        .values
        .iter()
        .find(|v| v.key == "params.amount")
        .unwrap();
    assert_eq!(
        (amount.label.as_deref(), amount.description.as_deref()),
        (None, None)
    );
}

#[test]
fn every_built_in_kind_says_what_it_is() {
    let schema = described().tree().registry().schema();
    for name in ["document", "pixel", "vector", "text"] {
        let t = schema.types.iter().find(|t| t.name == name).unwrap();
        assert!(t.label.is_some() && t.summary.is_some(), "{name}");
    }
    let group = |n: &str| {
        schema
            .types
            .iter()
            .find(|t| t.name == n)
            .and_then(|t| t.group.clone())
    };
    assert_eq!(group("document").as_deref(), Some("document"));
    for n in ["pixel", "vector", "text"] {
        assert_eq!(group(n).as_deref(), Some("layer"), "{n}");
    }
}
