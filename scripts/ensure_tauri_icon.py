#!/usr/bin/env python3
"""Create the Windows ICO resource from the tracked PNG app icon."""
from __future__ import annotations

import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PNG = ROOT / "frontend" / "src-tauri" / "icons" / "icon.png"
ICO = ROOT / "frontend" / "src-tauri" / "icons" / "icon.ico"


def build_icon() -> None:
    payload = PNG.read_bytes()
    if payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG icon: {PNG}")
    width, height = struct.unpack(">II", payload[16:24])
    if not (1 <= width <= 256 and 1 <= height <= 256):
        raise ValueError(f"unsupported icon dimensions: {width}x{height}")
    width_byte = 0 if width == 256 else width
    height_byte = 0 if height == 256 else height
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII",
        width_byte,
        height_byte,
        0,
        0,
        1,
        32,
        len(payload),
        6 + 16,
    )
    ICO.write_bytes(header + entry + payload)
    print(f"generated {ICO.relative_to(ROOT)} from {PNG.relative_to(ROOT)}")


if __name__ == "__main__":
    build_icon()
