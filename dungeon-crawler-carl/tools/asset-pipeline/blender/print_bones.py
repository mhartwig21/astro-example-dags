"""Print armature bone hierarchies + animation clips of one or more GLBs.

Debug aid for retargeting: shows what bone names a clip's tracks will bind to.

    blender --background --python blender/print_bones.py -- a.glb [b.glb ...]
"""

from __future__ import annotations

import sys

import bpy


def dump(path: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    print(f"\n=== {path}")
    for obj in bpy.data.objects:
        if obj.type != "ARMATURE":
            continue
        print(f"armature object: {obj.name!r} (data: {obj.data.name!r})")

        def walk(bone, depth):
            head = tuple(round(v, 3) for v in bone.head_local)
            print("  " + "  " * depth + f"{bone.name}  head={head}")
            for child in bone.children:
                walk(child, depth + 1)

        for bone in obj.data.bones:
            if bone.parent is None:
                walk(bone, 0)
    for action in bpy.data.actions:
        print(f"action: {action.name!r}  frames={tuple(action.frame_range)}  "
              f"fcurves={len(action.fcurves)}")


argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
for p in argv:
    dump(p)
