"""Render sampled frames of a clip GLB playing on a character model.

Review aid for retargeted animations: imports the model, assigns the clip
GLB's action to the model's armature (tracks bind by bone name, same as the
game engine will), and renders N evenly-spaced frames.

    blender --background --python blender/render_clip_frames.py -- \
        --model adventurer.glb --clip extradition.glb \
        --out out/extradition/frames [--frames 6] [--size 400] [--angle 30]
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
    argv = argv[argv.index("--") + 1:] if "--" in argv else argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--clip", required=True, help="GLB whose first action to play")
    parser.add_argument("--out", required=True, help="output directory for frame PNGs")
    parser.add_argument("--frames", type=int, default=6)
    parser.add_argument("--size", type=int, default=400)
    parser.add_argument("--angle", type=float, default=30.0)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.model))
    model_arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    actions_before = set(bpy.data.actions)

    bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.clip))
    clip_actions = [a for a in bpy.data.actions if a not in actions_before]
    if not clip_actions:
        raise SystemExit(f"no action found in {args.clip}")
    action = clip_actions[0]
    # discard the clip file's own armature; we only wanted its action
    for obj in [o for o in bpy.data.objects if o.type == "ARMATURE" and o is not model_arm]:
        bpy.data.objects.remove(obj, do_unlink=True)

    model_arm.animation_data_create()
    model_arm.animation_data.action = action
    # Blender 4.4+ layered actions: an action from another datablock has its
    # own slot; without selecting it the assignment silently does nothing.
    if getattr(action, "slots", None):
        model_arm.animation_data.action_slot = action.slots[0]
    f0, f1 = (int(round(v)) for v in action.frame_range)

    corners = [o.matrix_world @ Vector(c)
               for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box]
    lo = Vector((min(c[i] for c in corners) for i in range(3)))
    hi = Vector((max(c[i] for c in corners) for i in range(3)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5) * 1.4  # headroom for the animation

    yaw = math.radians(args.angle)
    pitch = math.radians(70.0)
    distance = radius * 3.4
    cam_pos = center + Vector((
        distance * math.sin(pitch) * math.sin(yaw),
        -distance * math.sin(pitch) * math.cos(yaw),
        distance * math.cos(pitch),
    ))
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = cam_pos
    cam.rotation_euler = (center - cam_pos).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    os.makedirs(os.path.abspath(args.out), exist_ok=True)

    for i in range(args.frames):
        frame = round(f0 + (f1 - f0) * i / max(1, args.frames - 1))
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(
            os.path.abspath(args.out), f"frame_{i:02d}_f{frame}.png")
        bpy.ops.render.render(write_still=True)
        print(f"rendered frame {frame} -> {scene.render.filepath}")


if __name__ == "__main__":
    main()
