# Architecture

Trove-BP has two halves. The engine (`src/engine/`) reads and writes `.blueprint` files and does every editing operation; it is plain ES modules and runs in Node, which is how the tests and the corpus check work. The UI (`src/viewer/`, `src/editor/`, `src/app/`) draws models with three.js and drives the engine.

```
.blueprint ──decode──▶ document ──pack──▶ viewer payload ──mesh──▶ three.js
                 │                                        viewer/voxel-mesh
                 └──inspect──▶ editor rows ──edit list──▶ apply / flatten / transform ──encode──▶ .blueprint
                                                          engine/editor                       engine/codec
```

## The file format

A blueprint starts with `kiwib` and a little-endian `u32` version.

- **v3 and v4**: a LEB128 voxel count, then per voxel three zigzag varints (absolute x, y, z), a `u16` type and four bytes `b g r w`. Whatever follows is the entity section (placed objects). The decoder shifts coordinates so the smallest is 0 and remembers the shift as `offset`.
- **v5**: a zlib stream. Inside, eight `i32`s (origin x y z, size x y z, count, first cell), then `count - 1` cell deltas, `count` `u16` types and `count` `u32` colours (`w r g b`, high byte first). A cell index `l` is `x + z·sx + y·sx·sz`. The origin is the negated attachment point. The entity section follows the tables.

Trove writes v5 streams without a final block, so inflating must keep everything that decodes rather than fail on the truncation. `engine/zlib.js` does that with fflate's streaming inflater; the browser's `DecompressionStream` drops buffered output when it reports the truncation, which breaks large models.

`(type, w)` is the material. Types 21, 18, 54, 55 and 56 are solid, glass, tiled glass, glowing solid and glowing glass; `w` is the specular finish on solids and the opacity step on glass. Other types are the game's own (terrain, deco placeholders, collision) and the editor leaves their materials alone. `format.materialFor()` maps a voxel to its render kind (0 solid, 1 glass, 2 glow, 3 glowing glass), glass level `16 + 32·min(w, 7)` and specular index, and gives procedural terrain voxels the colours the game paints them.

## Source layout

| Path | Role |
| --- | --- |
| `src/engine/bytes.js` | Varints with the reference masking rules, Python floor division and half-even rounding, the `Fault` error type. |
| `src/engine/format.js` | The raw tables: version detection, v3/v4 records, v5 grid, render materials, the cell merge, and the table encoder. |
| `src/engine/codec.js` | Whole files: the v5 container, exact error messages, empty-placeholder detection, entity records. |
| `src/engine/zlib.js` | Inflate and deflate (fflate). |
| `src/engine/pack.js` | The viewer payload: one entry per occupied cell as typed arrays `{count, size, x, y, z, rgb, kind, level, spec?}`. Refuses empty placeholders and models over 250,000 voxels. |
| `src/engine/editor.js` | Inspect, apply an edit list, composite a layer stack, transform, `.qb` export and import, and the Creations check. |
| `src/engine/materials.js`, `transform.js`, `merge.js`, `lint.js`, `qb.js` | The material palette, quarter turns and mirrors, layer flattening, the Creations rules, and Qubicle Binary with Trove's `_a`/`_s`/`_t` maps. |
| `src/engine/api.js` | The editor UI was written against HTTP endpoints. This answers the same `FormData` requests with `Response` objects, in the page. |
| `src/engine/zip.js`, `dds.js` | A stored-zip writer for the `.qb` export, and an uncompressed DDS reader for the specular atlas. |
| `src/viewer/` | `voxel-mesh.js` builds geometry (only faces that can be seen) and runs Trove's object shader; `viewer.js` is the orbit viewer; `viewer-stage.js` adds the backdrop, sun control and PNG snapshot. |
| `src/editor/` | `voxel-scene.js` is the editor's scene (picking, strokes, overlays, layers); `editor.js` and `editor.css` are the Blueprint Editor UI. |
| `src/app/` | The page: model list, View/Edit modes, file opening, the specular-map loader and the demo lantern. |
| `public/vendor/three.min.js` | three.js r134, loaded as a classic script and used through `window.THREE`. |

## Rendering

`voxel-mesh.js` emits a face when nothing is beside it, or when an opaque voxel sits beside glass; glass never draws against a neighbour, so panes don't show internal quads. One mesh per material group (kind, glass level, finish). The fragment shader is Trove's `terrain.fragment` lighting with no world inputs: wrapped diffuse `pow(max(N·L·0.7 + 0.3, 0), 0.65)`, a specular lobe looked up in the 4×2 atlas by `(N·H, L·H)`, plus ambient. Glass opacity is `(level / 255)²`, raised wherever the highlight lands. The atlas is a game file, so it is loaded from the user's own install and kept in IndexedDB.

## Checking against the reference

`scripts/corpus-check.mjs` compares this engine with dumps made by the KiwiAPI implementation (its `kiwi-core` crate), which is the reference:

- **Viewer dumps** hold, per file, the voxel count, size and a SHA-256 over the packed arrays (`x y z` as `i32`, `rgb` as `u32`, `kind` `u8`, `level` `u16`, `spec` `u8`), or the error kind.
- **Editor dumps** run a fixed script on each file: inspect, an edit list that recolours, rematerialises, erases and adds voxels, three transforms, the Creations check for three item types, `.qb` export then re-import, and a two-layer flatten. Output files are compared after inflating (the deflate streams differ; the contents don't), `.qb` files byte for byte.

Results on Trove's live files (73,987 blueprints):

| Check | Files | Result |
| --- | --- | --- |
| Viewer payload | 73,987 | 67,848 identical, 6,125 empty placeholders and 14 oversized models refused the same way, 0 mismatches |
| Editor operations | 924 (every 100th v5 file, every 8th v3/v4, 5 placeholders) | All 9 operations identical on every file |

`tests/fixtures/` holds three tiny synthetic blueprints written by the reference encoder, with its expected outputs, so the unit tests check the engine against the reference without any game files.

## Known differences

- A v5 file whose zlib data is corrupt (not merely truncated) partway through may yield a partial model here where the reference reports it as empty. No shipped file does this.
- Saved v5 files are deflated by fflate at level 9, so their bytes differ from the reference's; the decoded contents are identical.
- Whole creature projects (a `.tmod` or several parts assembled on the game's rig), the game-model search and animation preview are not part of this app: they need the game's rig data.
