use kiwi_core::bpedit::{Fault, editor};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Uncompressed view of a blueprint file: v5 payload inflated, v3/v4 as is.
fn payload(b: &[u8]) -> Vec<u8> {
    if b.len() > 9 && b[5] == 5 { kiwi_core::bpedit::codec::inflate_v5(b).unwrap_or_default() } else { b.to_vec() }
}

fn err(f: Fault) -> Value {
    match f {
        Fault::Editor(m) => json!({"err": m}),
        other => json!({"err": "unhandled", "m": other.message()}),
    }
}

fn strip(mut s: Map<String, Value>) -> Value {
    s.remove("bytes");
    Value::Object(s)
}

pub fn edits_for(n: usize, size: [i64; 3]) -> Value {
    let mut out = Vec::new();
    for i in 0..n {
        if i % 7 == 3 { out.push(json!({"i": i, "rgb": (i as u64 * 2654435761) % 0xFFFFFF})); }
        if i % 11 == 5 { out.push(json!({"i": i, "type": 18, "w": i % 8})); }
        if i % 17 == 9 { out.push(json!({"i": i, "type": 55, "w": 3, "rgb": 0x123456})); }
        if i % 13 == 1 { out.push(json!({"i": i, "del": true})); }
    }
    out.push(json!({"add": [size[0], 0, 0], "rgb": 0xff8800, "type": 21, "w": 1}));
    out.push(json!({"add": [-1, 2, 1], "rgb": 0x00ff88, "type": 56, "w": 5}));
    out.push(json!({"add": [0, size[1] + 1, 0], "rgb": 0x8800ff, "type": 54, "w": 9}));
    Value::Array(out)
}

pub fn run(p: &str, raw: &[u8], layer: Option<&[u8]>) -> Value {
    let mut rec = Map::new();
    rec.insert("p".into(), json!(p));
    let ins = match editor::inspect(raw, "m") {
        Ok(v) => v,
        Err(f) => { rec.insert("inspect".into(), err(f)); return Value::Object(rec); }
    };
    rec.insert("inspect".into(), json!({"h": hex(ins.to_string().as_bytes())}));
    let n = ins["count"].as_u64().unwrap() as usize;
    let size: Vec<i64> = ins["size"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    let edits = edits_for(n, [size[0], size[1], size[2]]);
    rec.insert("apply".into(), match editor::apply_edits(raw, &edits) {
        Ok((d, s)) => json!({"h": hex(&payload(&d)), "s": strip(s)}),
        Err(f) => err(f),
    });
    let ops = json!(["rotate_y", "mirror_x", "rotate_x"]);
    rec.insert("transform".into(), match editor::transform(raw, &edits, &ops) {
        Ok((d, s)) => json!({"h": hex(&payload(&d)), "s": s}),
        Err(f) => err(f),
    });
    for kind in ["melee", "hat", "deco"] {
        rec.insert(format!("check_{kind}"), match editor::check(raw, &Value::Array(vec![]), kind, &[], &Value::Array(vec![]), 0) {
            Ok(v) => json!({"h": hex(v.to_string().as_bytes())}),
            Err(f) => err(f),
        });
    }
    match editor::export_qb(raw, &edits, &[], &Value::Array(vec![]), 0, "m") {
        Ok((files, s)) => {
            let hs: Vec<String> = files.iter().map(|(n, d)| format!("{n}:{}", hex(d))).collect();
            rec.insert("export".into(), json!({"files": hs, "s": s}));
            rec.insert("import".into(), match editor::import_qb(&files) {
                Ok((d, s)) => json!({"h": hex(&payload(&d)), "s": s}),
                Err(f) => err(f),
            });
        }
        Err(f) => { rec.insert("export".into(), err(f)); }
    }
    if let Some(l) = layer {
        let specs = json!([{"mode": "centre", "offset": [1, 0, -1]}]);
        rec.insert("flatten".into(), match editor::composite(raw, &Value::Array(vec![]), &[l], &specs, 1) {
            Ok((d, s)) => json!({"h": hex(&payload(&d)), "s": strip(s)}),
            Err(f) => err(f),
        });
    }
    Value::Object(rec)
}
