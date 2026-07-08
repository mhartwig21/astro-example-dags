"""Render a GLB to a PNG turntable frame for review contact sheets.

Uses the Workbench engine (CPU-friendly, flat texture display) so previews
show atlas colors without lighting setup.

    blender --background --python render_preview.py -- \
        --input model.glb --output preview.png [--size 512] [--angle 30]
or with the bpy pip module:
    python3 blender/render_preview.py --input model.glb --output preview.png
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, nargs="+", help="one or more .glb files, laid out in a row")
    parser.add_argument("--output", required=True, help="output .png")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--angle", type=float, default=30.0, help="camera yaw in degrees")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    offset = 0.0
    for path in args.input:
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
        added = set(bpy.context.scene.objects) - before
        corners = [
            o.matrix_world @ Vector(c)
            for o in added
            if o.type == "MESH"
            for c in o.bound_box
        ]
        lo_x = min(c.x for c in corners) if corners else 0.0
        hi_x = max(c.x for c in corners) if corners else 1.0
        for obj in (o for o in added if o.parent is None):
            obj.location.x += offset - lo_x
        offset += (hi_x - lo_x) * 1.3

    bpy.context.view_layer.update()  # moved objects: refresh matrix_world before framing
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(c[i] for c in corners) for i in range(3)))
    hi = Vector((max(c[i] for c in corners) for i in range(3)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)

    yaw = math.radians(args.angle)
    pitch = math.radians(60.0)
    distance = radius * 3.4
    cam_pos = center + Vector(
        (
            distance * math.sin(pitch) * math.sin(yaw),
            -distance * math.sin(pitch) * math.cos(yaw),
            distance * math.cos(pitch),
        )
    )
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = cam_pos
    direction = center - cam_pos
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = args.size * max(1, len(args.input))
    scene.render.resolution_y = args.size
    scene.render.film_transparent = False
    scene.render.filepath = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print(f"rendered {args.output}")


if __name__ == "__main__":
    main()
