"""Strip a Meshy animation GLB to an armature-only clip with a chosen name.

The game's clip animator binds AnimationClips to a model's skeleton by BONE
NAME and finds clips by CLIP NAME (fuzzy regexes: Idle, Walking_A, Attack,
Hit_A, Death_A...). A Meshy animation GLB already carries the clip on the
creature's own skeleton — this just renames the action and drops the mesh so
the file is a lightweight clip library of one.

    blender --background --python blender/rename_clip.py -- \
        --input animated.glb --name Idle --out idle.glb
"""

from __future__ import annotations

import sys

import bpy


def parse():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else argv[1:]
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


args = parse()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.input)

actions = list(bpy.data.actions)
if not actions:
    raise SystemExit("no animation in input GLB")
actions[0].name = args.name
for extra in actions[1:]:
    bpy.data.actions.remove(extra)

# Keep only armatures (the clip binds by bone name; the mesh ships separately).
for obj in list(bpy.data.objects):
    if obj.type != "ARMATURE":
        bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_animations=True)
print(f"clip '{args.name}' -> {args.out}")
