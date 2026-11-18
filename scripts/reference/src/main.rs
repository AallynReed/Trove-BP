//! Reference dumps for scripts/corpus-check.mjs: `reference-dump [edit|fixtures] <list.txt|dir>`.
mod edit;
mod fixtures;
use std::io::{BufRead, Write};
use kiwi_core::voxel::{self, PackError};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn zinfo(raw: &[u8]) -> Value {
    if raw.len() < 9 || &raw[..5] != b"kiwib" || u32::from_le_bytes([raw[5], raw[6], raw[7], raw[8]]) != 5 {
        return Value::Null;
    }
    let input = &raw[9..];
    let mut d = flate2::Decompress::new(true);
    let mut out = Vec::with_capacity(1 << 20);
    loop {
        if out.len() == out.capacity() { out.reserve(out.len()); }
        let before = (d.total_in(), d.total_out());
        match d.decompress_vec(&input[d.total_in() as usize..], &mut out, flate2::FlushDecompress::None) {
            Err(_) => return json!({"bad": true}),
            Ok(flate2::Status::StreamEnd) => return json!({"end": true, "trailing": input.len() as u64 - d.total_in()}),
            Ok(_) if (d.total_in(), d.total_out()) == before && out.len() < out.capacity() => return json!({"end": false}),
            Ok(_) => {}
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "fixtures" { fixtures::run(&args[2]); return; }
    if args[1] == "edit" {
        let list: Vec<String> = std::fs::read_to_string(&args[2]).unwrap().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        let mut out = std::io::BufWriter::new(std::io::stdout().lock());
        for (i, p) in list.iter().enumerate() {
            let raw = std::fs::read(p).unwrap();
            let layer = list.get(i + 1).map(|q| std::fs::read(q).unwrap());
            writeln!(out, "{}", edit::run(p, &raw, layer.as_deref())).unwrap();
        }
        return;
    }
    let list = args[1].clone();
    let f = std::fs::File::open(list).unwrap();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::BufReader::new(f).lines() {
        let p = line.unwrap();
        let p = p.trim();
        if p.is_empty() { continue; }
        let raw = std::fs::read(p).unwrap();
        let mut rec = json!({"p": p, "z": zinfo(&raw)});
        match voxel::pack(&raw, "x", voxel::RENDER_VOXEL_CAP) {
            Ok(v) => {
                let n = v["count"].as_u64().unwrap() as usize;
                let mut h = Sha256::new();
                let arr = |k: &str| v[k].as_array().unwrap().clone();
                let (x, y, z, rgb, kind, level) = (arr("x"), arr("y"), arr("z"), arr("rgb"), arr("kind"), arr("level"));
                let spec = v.get("spec").map(|s| s.as_array().unwrap().clone());
                for i in 0..n {
                    h.update((x[i].as_i64().unwrap() as i32).to_le_bytes());
                    h.update((y[i].as_i64().unwrap() as i32).to_le_bytes());
                    h.update((z[i].as_i64().unwrap() as i32).to_le_bytes());
                    h.update((rgb[i].as_u64().unwrap() as u32).to_le_bytes());
                    h.update([kind[i].as_u64().unwrap() as u8]);
                    h.update((level[i].as_u64().unwrap() as u16).to_le_bytes());
                    h.update([spec.as_ref().map_or(0, |s| s[i].as_u64().unwrap() as u8)]);
                }
                let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
                rec["n"] = json!(n);
                rec["size"] = v["size"].clone();
                rec["spec"] = json!(spec.is_some());
                rec["h"] = json!(hex);
            }
            Err(PackError::Empty) => rec["err"] = json!("empty"),
            Err(PackError::TooLarge(n)) => rec["err"] = json!(format!("toolarge:{n}")),
            Err(PackError::Invalid(m)) => rec["err"] = json!(format!("invalid:{m}")),
            Err(PackError::Unhandled(m)) => rec["err"] = json!(format!("unhandled:{m}")),
        }
        writeln!(out, "{rec}").unwrap();
    }
}
