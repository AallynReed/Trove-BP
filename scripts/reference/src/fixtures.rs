use kiwi_core::blueprint::{InVoxel, encode};
use kiwi_core::bpedit::{codec, editor};
use serde_json::json;

fn v(x: i64, y: i64, z: i64, rgb: u32, ty: i64, w: i64) -> InVoxel {
    InVoxel::new(x, y, z, i64::from(rgb >> 16 & 255), i64::from(rgb >> 8 & 255), i64::from(rgb & 255), Some(w), Some(ty))
}

pub fn run(dir: &str) {
    let mut vox = Vec::new();
    for x in 0..4 { for z in 0..3 { vox.push(v(x, 0, z, 0x404850, 21, (x + z) % 6)); } }
    vox.push(v(1, 1, 1, 0x9fd8ff, 18, 3));
    vox.push(v(2, 1, 1, 0xc9b6ff, 54, 7));
    vox.push(v(1, 2, 1, 0xffb347, 55, 0));
    vox.push(v(2, 2, 1, 0xfff1a8, 56, 5));
    vox.push(v(0, 3, 0, 0x050505, 3, 0));
    vox.push(v(3, 3, 2, 0x101010, 39, 0));
    vox.push(v(1, 1, 1, 0x00ff00, 21, 1));
    let entity = codec::write_entity_records(&[(1, 2, 3, vec![9, 8, 7])], &[0xAA]);
    let v3 = encode(&vox, 3, None, None, [-2, 5, -1], &[]).unwrap();
    let v4 = encode(&vox, 4, None, None, [0, 0, 0], &entity).unwrap();
    let payload = encode(&vox, 5, Some([4, 4, 3]), Some([-1, 0, -1]), [0, 0, 0], &entity).unwrap();
    let mut v5 = b"kiwib".to_vec();
    v5.extend_from_slice(&5u32.to_le_bytes());
    v5.extend(kiwi_core::zlib::deflate(&payload, 9, usize::MAX, false).unwrap());
    let mut expect = serde_json::Map::new();
    for (name, bytes) in [("tiny-v3", &v3), ("tiny-v4", &v4), ("tiny-v5", &v5)] {
        std::fs::write(format!("{dir}/{name}.blueprint"), bytes).unwrap();
        let mut packed = kiwi_core::voxel::pack(bytes, "x", 250_000).unwrap();
        packed.as_object_mut().unwrap().remove("path");
        let ins = editor::inspect(bytes, "m").unwrap();
        let edits = json!([{"i": 0, "rgb": 0x123456}, {"i": 3, "type": 18, "w": 2}, {"i": 5, "del": true}, {"add": [-1, 0, 0], "rgb": 0xff0000, "type": 55, "w": 0}]);
        let (applied, summary) = editor::apply_edits(bytes, &edits).unwrap();
        let applied_payload = if name == "tiny-v5" { codec::inflate_v5(&applied).unwrap() } else { applied.clone() };
        let (moved, _) = editor::transform(bytes, &json!([]), &json!(["rotate_z", "mirror_y"])).unwrap();
        let moved_payload = if name == "tiny-v5" { codec::inflate_v5(&moved).unwrap() } else { moved.clone() };
        let (qb_files, _) = editor::export_qb(bytes, &json!([]), &[], &json!([]), 0, "m").unwrap();
        expect.insert(name.into(), json!({
            "pack": packed,
            "inspect_materials": ins["materials"],
            "inspect_stats": ins["stats"],
            "apply_summary": summary,
            "apply_hex": crate::edit::hex(&applied_payload),
            "transform_hex": crate::edit::hex(&moved_payload),
            "qb": qb_files.iter().map(|(n, d)| (n.clone(), crate::edit::hex(d))).collect::<Vec<_>>(),
            "check_melee": editor::check(bytes, &json!([]), "melee", &[], &json!([]), 0).unwrap(),
        }));
    }
    std::fs::write(format!("{dir}/expected.json"), serde_json::to_string_pretty(&expect).unwrap()).unwrap();
}
