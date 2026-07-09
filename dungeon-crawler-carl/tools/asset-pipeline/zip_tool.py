"""Search/extract the owner's KayKit collection zip (builder-bridge helper).

    python zip_tool.py search <term>
        -> JSON list of matching model entries (.gltf/.glb, skipping the
           fbx/obj duplicates), capped at 50.
    python zip_tool.py extract <entry-path> <out-dir>
        -> extracts the model plus its .bin buffers and texture images
           (parsed from the gltf) into out-dir; prints {"main": path}.

Zip location defaults to the dev box's Downloads; override with KAYKIT_ZIP.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile

ZIP = os.environ.get(
    "KAYKIT_ZIP",
    r"C:\Users\hartw\Downloads\The Complete KayKit Collection v6.zip",
)


def main() -> None:
    cmd = sys.argv[1]
    z = zipfile.ZipFile(ZIP)
    if cmd == "search":
        q = sys.argv[2].lower()
        hits = [
            n for n in z.namelist()
            if q in n.lower()
            and n.lower().endswith((".gltf", ".glb"))
            and "/fbx" not in n.lower() and "/obj" not in n.lower()
        ]
        print(json.dumps(hits[:50]))
        return
    if cmd == "extract":
        path, outdir = sys.argv[2], sys.argv[3]
        os.makedirs(outdir, exist_ok=True)
        base = os.path.dirname(path)

        def put(name: str) -> str:
            dest = os.path.join(outdir, os.path.basename(name))
            with z.open(name) as src, open(dest, "wb") as f:
                shutil.copyfileobj(src, f)
            return dest

        main_file = put(path)
        if path.lower().endswith(".gltf"):
            data = json.loads(z.read(path))
            for section in ("buffers", "images"):
                for entry in data.get(section, []):
                    uri = entry.get("uri")
                    if uri and not uri.startswith("data:"):
                        put(f"{base}/{uri}")
        print(json.dumps({"main": main_file}))
        return
    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
