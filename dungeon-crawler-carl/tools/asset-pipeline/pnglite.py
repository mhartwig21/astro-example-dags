"""Minimal stdlib-only PNG codec.

Supports reading 8-bit-per-channel, non-interlaced PNGs in greyscale (0),
RGB (2), palette (3), greyscale+alpha (4) and RGBA (6) color types — enough
for KayKit atlases and Meshy textures. Writing is RGB/RGBA only.

All pixel data is exchanged as (width, height, rows) where rows is a list of
bytearrays of RGBA bytes, top row first.
"""

from __future__ import annotations

import struct
import zlib

_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path: str) -> tuple[int, int, list[bytearray]]:
    """Decode a PNG file to (width, height, RGBA rows)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != _SIGNATURE:
        raise ValueError(f"{path}: not a PNG file")

    pos = 8
    width = height = 0
    color_type = bit_depth = 0
    palette: bytes = b""
    trns: bytes = b""
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if bit_depth != 8:
                raise ValueError(f"{path}: only 8-bit PNGs supported (got {bit_depth})")
            if interlace != 0:
                raise ValueError(f"{path}: interlaced PNGs not supported")
        elif ctype == b"PLTE":
            palette = chunk
        elif ctype == b"tRNS":
            trns = chunk
        elif ctype == b"IDAT":
            idat.extend(chunk)
        elif ctype == b"IEND":
            break

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    rows: list[bytearray] = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                upleft = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        elif ftype != 0:
            raise ValueError(f"{path}: unknown PNG filter type {ftype}")
        prev = line

        rgba = bytearray(width * 4)
        if color_type == 6:
            rgba[:] = line
        elif color_type == 2:
            for x in range(width):
                rgba[x * 4 : x * 4 + 3] = line[x * 3 : x * 3 + 3]
                rgba[x * 4 + 3] = 255
        elif color_type == 0:
            for x in range(width):
                g = line[x]
                rgba[x * 4 : x * 4 + 4] = bytes((g, g, g, 255))
        elif color_type == 4:
            for x in range(width):
                g, a = line[x * 2], line[x * 2 + 1]
                rgba[x * 4 : x * 4 + 4] = bytes((g, g, g, a))
        elif color_type == 3:
            for x in range(width):
                idx = line[x]
                rgba[x * 4 : x * 4 + 3] = palette[idx * 3 : idx * 3 + 3]
                rgba[x * 4 + 3] = trns[idx] if idx < len(trns) else 255
        rows.append(rgba)
    return width, height, rows


def write_png(path: str, width: int, height: int, rows: list[bytearray]) -> None:
    """Encode RGBA rows (top row first) to a PNG file."""

    def chunk(ctype: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter: None
        raw.extend(row)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(_SIGNATURE)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))
