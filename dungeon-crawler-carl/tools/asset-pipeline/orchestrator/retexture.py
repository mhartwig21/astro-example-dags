"""Retexture an existing model: new skin, same geometry (~cheap credits).

    python3 orchestrator/retexture.py --input path/to/model.glb \
        --prompt "mossy weathered stone" --out out/mossy-cage/mossy-cage.glb

The input GLB uploads as a data URI; the result downloads to --out. Resumable
via the same stage() cache pattern as the other runners (task id cached in
the output directory). Requires MESHY_API_KEY.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from meshy import RETEXTURE, MeshyClient  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="existing .glb to reskin")
    ap.add_argument("--prompt", required=True, help="texture style prompt")
    ap.add_argument("--out", required=True, help="output .glb path")
    args = ap.parse_args()

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    os.makedirs(out_dir, exist_ok=True)
    client = MeshyClient()

    cache = os.path.join(out_dir, "retexture_task.json")
    if os.path.exists(cache):
        with open(cache) as f:
            task = json.load(f)
        print("  retexture: skip (cached)")
    else:
        print("retexture:")
        task = client.poll(RETEXTURE, client.retexture(args.input, args.prompt))
        with open(cache, "w") as f:
            json.dump(task, f, indent=2)

    url = (task.get("model_urls") or {}).get("glb") or (task.get("result") or {}).get("glb_url")
    if not url:
        raise SystemExit(f"no glb url in retexture result: {json.dumps(task)[:400]}")
    if not os.path.exists(args.out):
        print("download:")
        client.download(url, args.out)
    print(json.dumps({"out": args.out}))


if __name__ == "__main__":
    main()
