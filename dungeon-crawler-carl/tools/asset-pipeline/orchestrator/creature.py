"""The creature compiler: prompt -> playable animated character.

text-to-3D (T-pose prompt suffix) -> Meshy auto-rig -> the standard preset
clip set on the creature's OWN skeleton -> armature-only clip GLBs renamed to
the game's clip-matcher vocabulary. No cross-skeleton retargeting anywhere.

Output layout (drop under public/assets/generated/<id>/):
    <id>.glb          rigged body (Meshy texture; palette snap intentionally
                      skipped for rigged bodies — re-UV vs skinning is untested)
    clip_idle.glb ... armature-only clips: Idle, Walking_A, Attack, Hit_A, Death_A

Usage:
    python3 orchestrator/creature.py --id sewer-mascot \
        --prompt "fuzzy corporate mascot costume monster" --out out/sewer-mascot

Resumable like the other runners; ~40 credits per creature (20 model,
5 rig, 3 x 5 clips). Requires MESHY_API_KEY + BLENDER_BIN.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from meshy import ANIMATIONS, RIGGING, TEXT_TO_3D, MeshyClient  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The standard set the game's clip animator expects (fuzzy regex targets).
CLIP_SET = [
    ("Idle", 89),       # Combat_Stance
    ("Walking_A", 1),   # Walking_Woman
    ("Attack", 96),     # Kung_Fu_Punch
    ("Hit_A", 178),     # Hit_Reaction
    ("Death_A", 8),     # Dead
]

HOUSE_SUFFIX = ", T-pose, stylized game character, chunky proportions, flat colors"


def stage(out_dir: str, name: str, produce) -> dict:
    path = os.path.join(out_dir, f"{name}.json")
    if os.path.exists(path):
        with open(path) as f:
            print(f"  {name}: skip (cached)")
            return json.load(f)
    result = produce()
    with open(path, "w") as f:
        json.dump(result, f, indent=2)
    return result


def blender(script: str, *args: str) -> None:
    bin_ = os.environ.get("BLENDER_BIN")
    if not bin_:
        raise SystemExit("BLENDER_BIN not set")
    r = subprocess.run(
        [bin_, "--background", "--python", os.path.join(ROOT, "blender", script), "--", *args],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{script} failed:\n{r.stdout[-1200:]}\n{r.stderr[-800:]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--id", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--height", type=float, default=1.6)
    ap.add_argument("--polycount", type=int, default=6000)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    client = MeshyClient()

    print("model:")
    model = stage(args.out, "model_task", lambda: client.poll(TEXT_TO_3D, client.text_to_3d_refine(
        client.poll(TEXT_TO_3D, client.text_to_3d_preview(
            args.prompt + HOUSE_SUFFIX, target_polycount=args.polycount, topology="triangle"))["id"])))

    print("rig:")
    rig = stage(args.out, "rig_task", lambda: client.poll(
        RIGGING, client.rig(model["id"], height_meters=args.height)))
    body_url = rig["result"]["rigged_character_glb_url"]
    body = os.path.join(args.out, f"{args.id}.glb")
    if not os.path.exists(body):
        print("download body:")
        client.download(body_url, body)

    clips: list[str] = []
    for clip_name, action in CLIP_SET:
        key = f"anim_{clip_name.lower()}"
        print(f"clip {clip_name}:")
        anim = stage(args.out, key, lambda a=action: client.poll(
            ANIMATIONS, client.animate(rig["id"], a)))
        raw = os.path.join(args.out, f"{key}_raw.glb")
        url = (anim.get("result") or {}).get("animation_glb_url")
        if not url:
            raise SystemExit(f"no animation url for {clip_name}")
        if not os.path.exists(raw):
            client.download(url, raw)
        final = os.path.join(args.out, f"clip_{clip_name.lower()}.glb")
        if not os.path.exists(final):
            blender("rename_clip.py", "--input", os.path.abspath(raw),
                    "--name", clip_name, "--out", os.path.abspath(final))
        clips.append(final)

    print(json.dumps({"id": args.id, "body": body, "clips": clips}))


if __name__ == "__main__":
    main()
