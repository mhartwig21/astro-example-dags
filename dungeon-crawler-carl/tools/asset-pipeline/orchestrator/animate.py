"""Rig a humanoid model with Meshy and apply a preset animation clip.

Phase-3 spike (plan-v2 stages F/G): produces an animated GLB on Meshy's
skeleton. Retargeting the clip onto a house rig is a separate Blender step
(blender/retarget_clip.py).

Usage:
    python3 orchestrator/animate.py --model <url|path|task-id> \
        --action-id 239 [--height 1.7] [--fps 30] --out out/extradition

Requires MESHY_API_KEY. Stages are resumable: task ids and downloads are
cached in --out; delete files there to redo a stage. Rigging is humanoid-only
and the model must face +Z. Cost: ~5 credits (rig) + ~3 credits (animate).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from meshy import ANIMATIONS, RIGGING, MeshyClient  # noqa: E402


def stage(out_dir: str, name: str, produce) -> dict:
    """Run a stage unless its cached JSON already exists."""
    path = os.path.join(out_dir, f"{name}.json")
    if os.path.exists(path):
        with open(path) as f:
            print(f"  {name}: skip (cached)")
            return json.load(f)
    result = produce()
    with open(path, "w") as f:
        json.dump(result, f, indent=2)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True,
                        help="https URL, local .glb path, or Meshy task id")
    parser.add_argument("--action-id", type=int, required=True,
                        help="preset clip id (docs.meshy.ai/en/api/animation-library)")
    parser.add_argument("--height", type=float, default=1.7,
                        help="character height in meters (rigging accuracy)")
    parser.add_argument("--fps", type=int, default=None, choices=(24, 25, 30, 60))
    parser.add_argument("--out", required=True, help="output directory")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    client = MeshyClient()

    def progress(task):
        print(f"    {task.get('status')} {task.get('progress', '')}", flush=True)

    print("rig:")
    rig = stage(args.out, "rig_task", lambda: client.poll(
        RIGGING, client.rig(args.model, height_meters=args.height)))

    print("animate:")
    anim = stage(args.out, "anim_task", lambda: client.poll(
        ANIMATIONS, client.animate(rig["id"], args.action_id, fps=args.fps),
        on_progress=progress))

    # verified live 2026-07-08: the animate result carries animation_glb_url
    # (not the model_urls dict the generation endpoints use)
    result = anim.get("result") or {}
    glb_url = (result.get("animation_glb_url")
               or (result.get("model_urls") or {}).get("glb")
               or (anim.get("model_urls") or {}).get("glb"))
    if not glb_url:
        raise SystemExit(f"no GLB url in animation task result: {json.dumps(anim)[:800]}")
    dest = os.path.join(args.out, "animated.glb")
    if os.path.exists(dest):
        print("download: skip (animated.glb exists)")
    else:
        print("download:")
        client.download(glb_url, dest)
    print(json.dumps({"rig_task": rig["id"], "anim_task": anim["id"], "glb": dest}))


if __name__ == "__main__":
    main()
