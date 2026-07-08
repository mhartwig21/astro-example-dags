"""Retarget a baked animation clip from one humanoid rig onto another.

Phase-3 spike (plan-v2 stage G). Source: a Meshy-animated GLB (Meshy's
auto-rig skeleton, Mixamo-style names). Target: a KayKit-rig GLB. Per frame,
each mapped target bone copies the source bone's world rotation with a
rest-pose delta correction (so differing rest orientations don't skew the
pose); the hips additionally copy scaled root motion. The result is baked to
a new action and exported as a clip-only GLB (armature + animation, no mesh)
whose track names bind to the game rig's bone names.

    blender --background --python blender/retarget_clip.py -- \
        --source out/extradition/animated.glb \
        --target ../public/assets/characters/adventurer.glb \
        --clip-name Extradition --out out/extradition/extradition.glb \
        [--fps 30] [--bone-map map.json]

Auto-mapping covers Meshy/Mixamo-style names -> KayKit deform bones; pass
--bone-map (JSON {source_bone: target_bone}) to override or extend.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

import bpy
from mathutils import Matrix

# Meshy auto-rig follows Mixamo-ish naming. Keys are normalized (lowercase,
# separators stripped, mixamorig prefix dropped); values are KayKit bones.
AUTO_MAP = {
    "hips": "hips",
    "pelvis": "hips",
    "spine": "spine",
    "spine1": "chest",
    "spine2": "chest",
    "chest": "chest",
    "neck": "head",
    "head": "head",
    "leftarm": "upperarm.l",
    "leftupperarm": "upperarm.l",
    "leftforearm": "lowerarm.l",
    "leftlowerarm": "lowerarm.l",
    "lefthand": "hand.l",
    "leftwrist": "hand.l",
    "rightarm": "upperarm.r",
    "rightupperarm": "upperarm.r",
    "rightforearm": "lowerarm.r",
    "rightlowerarm": "lowerarm.r",
    "righthand": "hand.r",
    "rightwrist": "hand.r",
    "leftupleg": "upperleg.l",
    "leftupperleg": "upperleg.l",
    "leftleg": "lowerleg.l",
    "leftlowerleg": "lowerleg.l",
    "leftfoot": "foot.l",
    "lefttoebase": "toes.l",
    "lefttoes": "toes.l",
    "rightupleg": "upperleg.r",
    "rightupperleg": "upperleg.r",
    "rightleg": "lowerleg.r",
    "rightlowerleg": "lowerleg.r",
    "rightfoot": "foot.r",
    "righttoebase": "toes.r",
    "righttoes": "toes.r",
}
# spine1/spine2 and neck/head both collapse onto one KayKit bone; when two
# source bones claim the same target, a key listed here beats one that isn't.
PREFERENCE = ["spine2", "head"]


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="animated GLB (source rig)")
    parser.add_argument("--target", required=True, help="GLB with the rig to bake onto")
    parser.add_argument("--clip-name", required=True, help="name of the baked action")
    parser.add_argument("--out", required=True, help="output .glb (armature + clip only)")
    parser.add_argument("--fps", type=int, default=30, help="bake sample rate")
    parser.add_argument("--bone-map", default=None,
                        help="JSON file {source_bone: target_bone} overriding auto-map")
    parser.add_argument("--frame-start", type=int, default=None,
                        help="bake from this source frame (default: clip start)")
    parser.add_argument("--frame-end", type=int, default=None,
                        help="bake up to this source frame (default: clip end); "
                             "trim follow-through that would clamp badly in-game")
    parser.add_argument("--rest-source", default=None,
                        help="GLB whose armature provides the source REST pose "
                             "(use the rig task's T-pose rigged_character output; "
                             "animated GLBs often bake the clip's first frame as "
                             "the bind pose, which skews the rest-delta)")
    return parser.parse_args(argv)


def normalize(name: str) -> str:
    n = name.lower()
    n = re.sub(r"^mixamorig:?", "", n)
    return re.sub(r"[\s_.\-:]", "", n)


def import_armature(path: str) -> bpy.types.Object:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    arms = [o for o in set(bpy.data.objects) - before if o.type == "ARMATURE"]
    if not arms:
        raise SystemExit(f"no armature in {path}")
    return arms[0]


def build_map(src_arm, tgt_arm, override: dict | None) -> dict[str, str]:
    tgt_names = {b.name for b in tgt_arm.data.bones}
    chosen: dict[str, str] = {}  # target bone -> source bone
    for bone in src_arm.data.bones:
        key = normalize(bone.name)
        tgt = AUTO_MAP.get(key)
        if tgt is None or tgt not in tgt_names:
            continue
        if tgt in chosen.values():
            # a bone already maps here; PREFERENCE keys win
            if key not in PREFERENCE:
                continue
            chosen = {t: s for t, s in chosen.items() if t != tgt}
        chosen[tgt] = bone.name
    mapping = {s: t for t, s in chosen.items()}
    if override:
        # value None drops a source bone; a new claim on a target evicts the
        # auto-mapped one (targets stay unique).
        for s, t in override.items():
            mapping = {s2: t2 for s2, t2 in mapping.items() if t2 != t and s2 != s}
            if t is not None:
                mapping[s] = t
    return mapping


def main() -> None:
    args = parse_args()
    override = None
    if args.bone_map:
        with open(args.bone_map) as f:
            override = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    tgt = import_armature(args.target)
    src = import_armature(args.source)
    scene = bpy.context.scene
    scene.render.fps = args.fps

    mapping = build_map(src, tgt, override)
    if "hips" not in mapping.values():
        raise SystemExit(f"no hips mapping found; source bones: "
                         f"{[b.name for b in src.data.bones][:40]}")
    print(f"bone map ({len(mapping)}):")
    for s, t in sorted(mapping.items(), key=lambda kv: kv[1]):
        print(f"  {s} -> {t}")

    # Rest-pose world matrices (rotation part is what the delta corrects).
    rest_arm = src
    if args.rest_source:
        rest_arm = import_armature(args.rest_source)
        missing = {b.name for b in src.data.bones} - {b.name for b in rest_arm.data.bones}
        if missing & set(mapping):
            raise SystemExit(f"rest-source lacks mapped bones: {sorted(missing)[:10]}")
    src_rest = {b.name: rest_arm.matrix_world @ b.matrix_local
                for b in rest_arm.data.bones}
    tgt_rest = {b.name: tgt.matrix_world @ b.matrix_local for b in tgt.data.bones}

    src_hips = next(s for s, t in mapping.items() if t == "hips")
    scale = (tgt_rest["hips"].translation.z or 1.0) / (
        src_rest[src_hips].translation.z or 1.0)

    src_action = src.animation_data.action if src.animation_data else None
    if src_action is None:
        raise SystemExit("source armature has no action")
    f0, f1 = (int(round(v)) for v in src_action.frame_range)
    if args.frame_start is not None:
        f0 = max(f0, args.frame_start)
    if args.frame_end is not None:
        f1 = min(f1, args.frame_end)

    # Fresh action on the target.
    for other in [o for o in bpy.data.actions if o is not src_action]:
        bpy.data.actions.remove(other)
    tgt.animation_data_create()
    action = bpy.data.actions.new(args.clip_name)
    tgt.animation_data.action = action

    # Bones in parent-before-child order so matrix_basis math can assume the
    # parent's pose matrix for this frame is already computed.
    order: list[bpy.types.Bone] = []
    stack = [b for b in tgt.data.bones if b.parent is None]
    while stack:
        b = stack.pop()
        order.append(b)
        stack.extend(b.children)
    tgt_by_src = {s: t for s, t in mapping.items()}

    world_inv = tgt.matrix_world.inverted()
    for frame in range(f0, f1 + 1):
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        src_eval = src.evaluated_get(depsgraph)
        src_pose_world = {
            name: src.matrix_world @ src_eval.pose.bones[name].matrix
            for name in mapping
        }
        # Desired armature-space pose matrix per target bone this frame.
        pose_arm: dict[str, Matrix] = {}
        for bone in order:
            name = bone.name
            src_name = next((s for s, t in tgt_by_src.items() if t == name), None)
            if src_name is not None:
                delta = src_rest[src_name].inverted() @ tgt_rest[name]
                world = src_pose_world[src_name] @ delta
                if name == "hips":
                    rest_loc = tgt_rest[name].translation
                    moved = (src_pose_world[src_name].translation
                             - src_rest[src_name].translation) * scale
                    world = world.copy()
                    world.translation = rest_loc + moved
                pose_arm[name] = world_inv @ world
            else:
                # unmapped bone: keep rest offset relative to its (posed) parent
                if bone.parent is None:
                    pose_arm[name] = bone.matrix_local.copy()
                else:
                    rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
                    pose_arm[name] = pose_arm[bone.parent.name] @ rel
        for bone in order:
            name = bone.name
            if bone.parent is None:
                basis = bone.matrix_local.inverted() @ pose_arm[name]
            else:
                rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
                basis = (rel.inverted()
                         @ pose_arm[bone.parent.name].inverted()
                         @ pose_arm[name])
            pbone = tgt.pose.bones[name]
            keyed = name in tgt_by_src.values() or bone.parent is None
            if not keyed:
                continue
            pbone.rotation_mode = "QUATERNION"
            pbone.rotation_quaternion = basis.to_quaternion()
            pbone.keyframe_insert("rotation_quaternion", frame=frame)
            if name == "hips":
                pbone.location = basis.to_translation()
                pbone.keyframe_insert("location", frame=frame)

    # Export just the target armature + the baked clip.
    for obj in list(bpy.data.objects):
        if obj is not tgt:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.actions.remove(src_action)
    scene.frame_start, scene.frame_end = f0, f1
    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_yup=True,
    )
    print(json.dumps({
        "clip": args.clip_name,
        "frames": [f0, f1],
        "fps": args.fps,
        "mapped_bones": len(mapping),
        "out": args.out,
    }))


if __name__ == "__main__":
    main()
