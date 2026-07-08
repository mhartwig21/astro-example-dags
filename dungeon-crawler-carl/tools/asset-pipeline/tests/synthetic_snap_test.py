"""Self-test for the palette-snap quality gate. Needs the bpy module.

Builds a synthetic "Meshy-like" model — a cube and a cone textured with
deliberately OFF-palette colors (pink / teal / lime) — runs palette_snap on
it, and asserts the output:
  * has exactly one material, referencing the master atlas image,
  * has every face UV sitting on a palette swatch (so every rendered color
    is a KayKit atlas color).

Run from the asset-pipeline directory:
    python3 tests/synthetic_snap_test.py
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from extract_atlas import read_glb  # noqa: E402

OUT = os.path.join(ROOT, "out", "test")
SYNTHETIC = os.path.join(OUT, "synthetic_raw.glb")
SNAPPED = os.path.join(OUT, "synthetic_snapped.glb")
PALETTE = os.path.join(ROOT, "palette", "palette.json")
ATLAS = os.path.join(ROOT, "palette", "dungeon_texture.png")


def build_synthetic() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # A small texture of colors nowhere near the KayKit palette.
    img = bpy.data.images.new("offpalette", width=64, height=64)
    px = [0.0] * (64 * 64 * 4)
    bands = [(1.0, 0.2, 0.8), (0.1, 0.9, 0.8), (0.6, 1.0, 0.1), (0.2, 0.3, 1.0)]
    for y in range(64):
        r, g, b = bands[(y * len(bands)) // 64]
        for x in range(64):
            i = (y * 64 + x) * 4
            px[i : i + 4] = [r, g, b, 1.0]
    img.pixels = px

    mat = bpy.data.materials.new("offpalette")
    mat.use_nodes = True
    principled = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    mat.node_tree.links.new(tex.outputs["Color"], principled.inputs["Base Color"])

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
    bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1.0, location=(1.5, 0, 0.5))
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            obj.data.materials.append(mat)
            # Primitives ship with a default UV layer; leave as-is so faces
            # sample different bands of the off-palette texture.

    os.makedirs(OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=SYNTHETIC, export_format="GLB")


def run_snap() -> dict:
    script = os.path.join(ROOT, "blender", "palette_snap.py")
    report_path = os.path.join(OUT, "synthetic_report.json")
    script_args = [
        "--input", SYNTHETIC,
        "--output", SNAPPED,
        "--palette", PALETTE,
        "--atlas", ATLAS,
        "--target-height", "1.0",
        "--report", report_path,
    ]
    # Same dual mode as orchestrator/run.py: external Blender via BLENDER_BIN,
    # else this Python (needs the bpy pip module).
    blender_bin = os.environ.get("BLENDER_BIN")
    if blender_bin:
        cmd = [blender_bin, "--background", "--python", script, "--", *script_args]
    else:
        cmd = [sys.executable, script, *script_args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"palette_snap failed:\n{result.stdout}\n{result.stderr}")
    with open(report_path) as f:
        return json.load(f)


def read_accessor_vec2(gltf: dict, binary: bytes, accessor_index: int) -> list[tuple]:
    acc = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    assert acc["componentType"] == 5126 and acc["type"] == "VEC2"
    out = []
    for i in range(acc["count"]):
        out.append(struct.unpack_from("<ff", binary, start + i * 8))
    return out


def verify() -> None:
    gltf, binary = read_glb(SNAPPED)
    materials = gltf.get("materials", [])
    assert len(materials) == 1, f"expected 1 material, got {len(materials)}"
    images = gltf.get("images", [])
    assert len(images) == 1, f"expected 1 image, got {len(images)}"
    assert "dungeon" in (images[0].get("name") or ""), images[0]

    with open(PALETTE) as f:
        palette = json.load(f)
    # glTF UVs have a top-left origin; palette UVs are Blender bottom-left.
    swatch_uvs = {(round(u, 3), round(1.0 - v, 3)) for u, v in
                  (e["uv"] for e in palette["entries"])}
    checked = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            for u, v in read_accessor_vec2(gltf, binary, prim["attributes"]["TEXCOORD_0"]):
                assert (round(u, 3), round(v, 3)) in swatch_uvs, (
                    f"UV ({u:.4f}, {v:.4f}) is not on a palette swatch"
                )
                checked += 1
    assert checked > 0, "no UVs found to verify"
    print(f"verify: 1 material, atlas image embedded, {checked} UVs all on palette swatches")


def main() -> None:
    build_synthetic()
    report = run_snap()
    assert report["ok"], report
    assert report["swatches_used"] >= 3, (
        f"expected >=3 distinct swatches for 4 color bands, got {report['swatches_used']}"
    )
    verify()
    print("synthetic_snap_test: PASS")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
