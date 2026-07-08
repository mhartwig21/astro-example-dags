"""Palette-snap: force any textured GLB onto the master KayKit atlas.

This is the pipeline's quality gate for visual consistency. For every face of
the input model it samples the average color from whatever texture the model
came with (Meshy's per-asset texture, typically), snaps that color to the
nearest swatch of the master palette, and rewrites the face's UVs to that
swatch's location on the master atlas. All original materials are then
replaced by a single flat material that references the one shared atlas —
so every asset that passes through here textures from the same file the
KayKit assets use.

Run headless with Blender:
    blender --background --python palette_snap.py -- \
        --input raw.glb --output final.glb \
        --palette ../palette/palette.json --atlas ../palette/dungeon_texture.png

or directly with the bpy pip module:
    python3 palette_snap.py --input raw.glb --output final.glb ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from quantize import Palette  # noqa: E402


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:  # blender --background --python script.py -- <args>
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="input .glb")
    parser.add_argument("--output", required=True, help="output .glb")
    parser.add_argument("--palette", required=True, help="palette.json from build_palette.py")
    parser.add_argument("--atlas", required=True, help="master atlas PNG")
    parser.add_argument(
        "--target-height",
        type=float,
        default=None,
        help="scale the model uniformly so its Z extent equals this (world units)",
    )
    parser.add_argument("--max-tris", type=int, default=10000, help="validation budget")
    parser.add_argument("--report", default=None, help="write a JSON report here")
    return parser.parse_args(argv)


def linear_to_srgb(v: float) -> float:
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


class TextureSampler:
    """Per-material color lookup: image texture if present, else base color."""

    def __init__(self, material) -> None:
        self.pixels = None
        self.width = self.height = 0
        self.fallback = (200, 200, 200)
        if material is None:
            return
        if material.use_nodes:
            for node in material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    img = node.image
                    # .pixels holds the stored (sRGB-encoded for PNG) values,
                    # which is what the palette was built from. Reading it also
                    # forces packed/embedded images to load (has_data is False
                    # for them until first access, so don't gate on it).
                    pixels = img.pixels[:]
                    if pixels and img.size[0] > 0:
                        self.pixels = pixels
                        self.width, self.height = img.size
                        break
            principled = next(
                (n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None
            )
            if principled is not None:
                r, g, b, _a = principled.inputs["Base Color"].default_value
                self.fallback = tuple(
                    max(0, min(255, round(linear_to_srgb(c) * 255))) for c in (r, g, b)
                )

    def sample(self, uvs: list[tuple[float, float]]) -> tuple[int, int, int]:
        if self.pixels is None or not uvs:
            return self.fallback
        # Average the texture at each loop UV plus the face centroid.
        cu = sum(u for u, _ in uvs) / len(uvs)
        cv = sum(v for _, v in uvs) / len(uvs)
        total = [0.0, 0.0, 0.0]
        points = uvs + [(cu, cv)]
        for u, v in points:
            x = min(self.width - 1, int((u % 1.0) * self.width))
            y = min(self.height - 1, int((v % 1.0) * self.height))
            i = (y * self.width + x) * 4
            total[0] += self.pixels[i]
            total[1] += self.pixels[i + 1]
            total[2] += self.pixels[i + 2]
        n = len(points)
        return tuple(max(0, min(255, round(c / n * 255))) for c in total)


def snap_object(obj, palette: Palette, used: set, warnings: list) -> None:
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
        warnings.append(f"{obj.name}: had no UVs; created a UV layer")
    uv_data = mesh.uv_layers.active.data
    samplers = [TextureSampler(slot.material) for slot in obj.material_slots]
    if not samplers:
        samplers = [TextureSampler(None)]
        warnings.append(f"{obj.name}: no materials; snapping from fallback grey")
    for poly in mesh.polygons:
        sampler = samplers[min(poly.material_index, len(samplers) - 1)]
        loop_uvs = [tuple(uv_data[li].uv) for li in poly.loop_indices]
        entry = palette.nearest(sampler.sample(loop_uvs))
        used.add(tuple(entry["rgb"]))
        for li in poly.loop_indices:
            uv_data[li].uv = entry["uv"]


def make_master_material(atlas_path: str):
    mat = bpy.data.materials.new("kaykit_atlas")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    principled = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    principled.inputs["Roughness"].default_value = 1.0
    principled.inputs["Metallic"].default_value = 0.0
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.abspath(atlas_path))
    tex.interpolation = "Closest"
    mat.node_tree.links.new(tex.outputs["Color"], principled.inputs["Base Color"])
    return mat


def normalize(mesh_objects, target_height: float | None) -> None:
    """Uniformly scale to target height and set pivot to bottom-center."""
    from mathutils import Matrix, Vector

    corners = [
        obj.matrix_world @ Vector(c) for obj in mesh_objects for c in obj.bound_box
    ]
    lo = Vector((min(c[i] for c in corners) for i in range(3)))
    hi = Vector((max(c[i] for c in corners) for i in range(3)))
    scale = 1.0
    if target_height is not None and hi.z - lo.z > 1e-9:
        scale = target_height / (hi.z - lo.z)
    center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    xform = Matrix.Scale(scale, 4) @ Matrix.Translation(-center)
    roots = {obj for obj in mesh_objects if obj.parent is None}
    # Rigged meshes are parented to armatures; transform the armature instead.
    for obj in mesh_objects:
        top = obj
        while top.parent is not None:
            top = top.parent
        roots.add(top)
    for root in roots:
        if root.parent is None:
            root.matrix_world = xform @ root.matrix_world


def main() -> None:
    args = parse_args()
    palette = Palette.load(args.palette)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.input))
    mesh_objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not mesh_objects:
        raise SystemExit(f"{args.input}: no meshes found")

    used: set = set()
    warnings: list[str] = []
    for obj in mesh_objects:
        snap_object(obj, palette, used, warnings)

    master = make_master_material(args.atlas)
    for obj in mesh_objects:
        obj.data.materials.clear()
        obj.data.materials.append(master)
        for poly in obj.data.polygons:
            poly.material_index = 0

    normalize(mesh_objects, args.target_height)

    triangles = sum(
        len(p.vertices) - 2 for o in mesh_objects for p in o.data.polygons
    )
    if triangles > args.max_tris:
        warnings.append(f"triangle count {triangles} exceeds budget {args.max_tris}")

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.output), export_format="GLB"
    )

    report = {
        "input": args.input,
        "output": args.output,
        "meshes": len(mesh_objects),
        "triangles": triangles,
        "swatches_used": len(used),
        "palette_size": len(palette.entries),
        "warnings": warnings,
        "ok": not any("exceeds budget" in w for w in warnings),
    }
    if args.report:
        with open(args.report, "w") as f:
            json.dump(report, f, indent=2)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
