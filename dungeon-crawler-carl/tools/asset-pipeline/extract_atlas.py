#!/usr/bin/env python3
"""Extract embedded textures from a .glb file.

The KayKit assets already shipped with the game embed their shared gradient
atlas in every GLB; this pulls the atlas out so it can become the pipeline's
master palette source.

Usage:
    python3 extract_atlas.py <model.glb> [-o output_dir]
"""

from __future__ import annotations

import argparse
import json
import os
import struct


def read_glb(path: str) -> tuple[dict, bytes]:
    """Return (gltf_json, binary_chunk) from a .glb file."""
    with open(path, "rb") as f:
        magic, _version, _length = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:  # 'glTF'
            raise ValueError(f"{path}: not a GLB file")
        gltf: dict = {}
        binary = b""
        while True:
            header = f.read(8)
            if len(header) < 8:
                break
            clen, ctype = struct.unpack("<II", header)
            chunk = f.read(clen)
            if ctype == 0x4E4F534A:  # 'JSON'
                gltf = json.loads(chunk)
            elif ctype == 0x004E4942:  # 'BIN'
                binary = chunk
    return gltf, binary


def extract_images(glb_path: str, out_dir: str) -> list[str]:
    gltf, binary = read_glb(glb_path)
    buffer_views = gltf.get("bufferViews", [])
    written: list[str] = []
    os.makedirs(out_dir, exist_ok=True)
    for i, image in enumerate(gltf.get("images", [])):
        if "bufferView" not in image:
            continue  # external URI image; nothing embedded to extract
        view = buffer_views[image["bufferView"]]
        start = view.get("byteOffset", 0)
        data = binary[start : start + view["byteLength"]]
        ext = {"image/png": "png", "image/jpeg": "jpg"}.get(image.get("mimeType"), "bin")
        name = image.get("name") or f"image_{i}"
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
        out_path = os.path.join(out_dir, f"{safe}.{ext}")
        with open(out_path, "wb") as f:
            f.write(data)
        written.append(out_path)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", help="input .glb file")
    parser.add_argument("-o", "--out-dir", default=".", help="output directory")
    args = parser.parse_args()
    written = extract_images(args.glb, args.out_dir)
    if not written:
        raise SystemExit(f"{args.glb}: no embedded images found")
    for path in written:
        print(path)


if __name__ == "__main__":
    main()
