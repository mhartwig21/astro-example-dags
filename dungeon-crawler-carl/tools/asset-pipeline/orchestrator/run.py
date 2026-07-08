#!/usr/bin/env python3
"""Manifest-driven asset pipeline runner.

For each asset in the manifest:
    generate  — Meshy text/image-to-3D (or copy a local source_glb) → raw.glb
    snap      — palette-snap onto the master KayKit atlas            → <id>.glb
    preview   — optional turntable render for review                 → preview.png

Stages are resumable: a stage whose output file already exists is skipped, so
re-running the manifest only does missing work. Delete an asset's out dir to
regenerate it.

Usage:
    python3 orchestrator/run.py --manifest manifest.json [--dry-run] [--only id]
                                 [--previews] [--out out/]

Requires MESHY_API_KEY for the generate stage (assets with source_glb skip it).
The snap/preview stages run Blender via $BLENDER_BIN, or in-process if the
bpy pip module is installed.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

DEFAULTS = {
    # "realistic" is the ONLY art_style the live v2 API accepts (verified via a
    # test-mode wire call 2026-07-05; "sculpture" now 400s). House style comes
    # from the prompt suffix + the palette-snap gate, not this knob.
    "art_style": "realistic",
    "target_polycount": 3000,
    "topology": "triangle",
    "target_height": 1.0,
    "max_tris": 8000,
    "palette": os.path.join(ROOT, "palette", "palette.json"),
    "atlas": os.path.join(ROOT, "palette", "dungeon_texture.png"),
}


def load_manifest(path: str) -> tuple[dict, list[dict]]:
    with open(path) as f:
        manifest = json.load(f)
    defaults = {**DEFAULTS, **manifest.get("defaults", {})}
    assets = manifest["assets"]
    seen = set()
    for asset in assets:
        if "id" not in asset or "type" not in asset:
            raise SystemExit(f"manifest asset missing id/type: {asset}")
        if asset["id"] in seen:
            raise SystemExit(f"duplicate asset id: {asset['id']}")
        seen.add(asset["id"])
    return defaults, assets


def blender_run(script: str, script_args: list[str], dry_run: bool) -> None:
    """Run a Blender-python script via $BLENDER_BIN, or this Python if bpy is available."""
    blender_bin = os.environ.get("BLENDER_BIN")
    if blender_bin:
        cmd = [blender_bin, "--background", "--python", script, "--", *script_args]
    elif importlib.util.find_spec("bpy") is not None:
        cmd = [sys.executable, script, *script_args]
    else:
        raise SystemExit(
            "no Blender available: set BLENDER_BIN or `pip install bpy`"
        )
    if dry_run:
        print("  would run:", " ".join(cmd))
        return
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"blender step failed ({script}):\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}"
        )


def stage_generate(asset: dict, cfg: dict, raw_path: str, task_path: str, dry_run: bool) -> None:
    source = asset.get("source_glb")
    if source:
        if dry_run:
            print(f"  would copy {source} -> {raw_path}")
            return
        shutil.copyfile(source, raw_path)
        return

    if dry_run:
        kind = "image-to-3d" if asset.get("image") else "text-to-3d preview+refine"
        print(f"  would generate via Meshy {kind}: {asset.get('prompt', asset.get('image'))!r}")
        return

    from meshy import IMAGE_TO_3D, TEXT_TO_3D, MeshyClient

    client = MeshyClient()
    if asset.get("image"):
        task_id = client.image_to_3d(
            asset["image"],
            target_polycount=cfg["target_polycount"],
            topology=cfg["topology"],
        )
        task = client.poll(IMAGE_TO_3D, task_id)
    else:
        preview_id = client.text_to_3d_preview(
            asset["prompt"],
            art_style=cfg["art_style"],
            target_polycount=cfg["target_polycount"],
            topology=cfg["topology"],
            seed=asset.get("seed"),
        )
        client.poll(TEXT_TO_3D, preview_id)
        refine_id = client.text_to_3d_refine(preview_id)
        task = client.poll(TEXT_TO_3D, refine_id)

    with open(task_path, "w") as f:
        json.dump(task, f, indent=2)
    glb_url = (task.get("model_urls") or {}).get("glb")
    if not glb_url:
        raise SystemExit(f"{asset['id']}: task succeeded but no GLB url: {task}")
    client.download(glb_url, raw_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=os.path.join(ROOT, "manifest.json"))
    parser.add_argument("--out", default=os.path.join(ROOT, "out"))
    parser.add_argument("--only", help="process just this asset id")
    parser.add_argument("--previews", action="store_true", help="render preview.png per asset")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    defaults, assets = load_manifest(args.manifest)
    if args.only:
        assets = [a for a in assets if a["id"] == args.only]
        if not assets:
            raise SystemExit(f"no asset with id {args.only!r} in manifest")

    results = []
    for asset in assets:
        cfg = {**defaults, **asset}
        asset_dir = os.path.join(args.out, asset["id"])
        raw_path = os.path.join(asset_dir, "raw.glb")
        final_path = os.path.join(asset_dir, f"{asset['id']}.glb")
        report_path = os.path.join(asset_dir, "report.json")
        preview_path = os.path.join(asset_dir, "preview.png")
        os.makedirs(asset_dir, exist_ok=True)
        print(f"[{asset['id']}]")

        if asset.get("rig"):
            print("  note: rigging requested but not wired up yet (Phase 3); producing static model")

        if os.path.exists(raw_path):
            print("  generate: skip (raw.glb exists)")
        else:
            print("  generate:")
            stage_generate(asset, cfg, raw_path, os.path.join(asset_dir, "task.json"), args.dry_run)

        if os.path.exists(final_path):
            print("  snap: skip (final glb exists)")
        else:
            print("  snap:")
            snap_args = [
                "--input", raw_path,
                "--output", final_path,
                "--palette", cfg["palette"],
                "--atlas", cfg["atlas"],
                "--max-tris", str(cfg["max_tris"]),
                "--report", report_path,
            ]
            if cfg.get("target_height"):
                snap_args += ["--target-height", str(cfg["target_height"])]
            blender_run(os.path.join(ROOT, "blender", "palette_snap.py"), snap_args, args.dry_run)

        if args.previews and not os.path.exists(preview_path):
            print("  preview:")
            blender_run(
                os.path.join(ROOT, "blender", "render_preview.py"),
                ["--input", final_path, "--output", preview_path],
                args.dry_run,
            )

        if not args.dry_run and os.path.exists(report_path):
            with open(report_path) as f:
                results.append({"id": asset["id"], **json.load(f)})

    if results:
        print(json.dumps({"processed": len(results),
                          "ok": sum(1 for r in results if r.get("ok")),
                          "reports": results}, indent=2))


if __name__ == "__main__":
    main()
