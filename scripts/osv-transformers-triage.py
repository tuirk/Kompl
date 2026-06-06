#!/usr/bin/env python3
"""Map Scorecard #70 OSV IDs to transformers fix boundaries."""
from __future__ import annotations

import json
import urllib.request

IDS = [
    "PYSEC-2023-299", "GHSA-282v-666c-3fvg",
    "GHSA-37mw-44qp-f5jm", "GHSA-37q5-v5qm-c9v8",
    "PYSEC-2023-300", "GHSA-3863-2447-669p",
    "GHSA-4w7r-h757-3r74", "GHSA-59p9-h35m-wg4g",
    "GHSA-69w3-r845-3855", "GHSA-6rvg-6v2m-4j46",
    "GHSA-9356-575x-2w9m", "GHSA-fpwr-67px-3qhx",
    "PYSEC-2024-229", "GHSA-hxxf-235m-72v3",
    "GHSA-jjph-296x-mrcr", "GHSA-phhr-52qp-3mj4",
    "GHSA-q2wp-rjmx-x6x9",
    "PYSEC-2025-40", "GHSA-qq3j-4f4f-9583",
    "PYSEC-2024-227", "GHSA-qxrp-vhvm-j765",
    "GHSA-rcv9-qm8p-9p6j",
    "PYSEC-2023-301", "GHSA-v68g-wm8c-6x7j",
    "PYSEC-2024-228", "GHSA-wrfc-pvp9-mr9g",
    "PYSEC-2025-211", "PYSEC-2025-212", "PYSEC-2025-213",
    "PYSEC-2025-214", "PYSEC-2025-215", "PYSEC-2025-216",
    "PYSEC-2025-217", "PYSEC-2025-218",
]

seen: set[str] = set()
max_la = ""
needs_5x: list[str] = []
for vid in IDS:
    if vid in seen:
        continue
    seen.add(vid)
    with urllib.request.urlopen(f"https://api.osv.dev/v1/vulns/{vid}", timeout=20) as r:
        v = json.load(r)
    pkg = v["affected"][0]
    la = fix = None
    for rng in pkg.get("ranges", []):
        for ev in rng.get("events", []):
            if "last_affected" in ev:
                la = ev["last_affected"]
            if "fixed" in ev:
                fix = ev["fixed"]
    if la and (not max_la or la > max_la):
        max_la = la
    if fix and fix.startswith("5."):
        needs_5x.append(f"{vid} (fix {fix})")
    print(f"{vid:22} last_affected={la or '-':10} fixed={fix or '-'}")

print(f"\nMax last_affected in 4.x: {max_la}")
print(f"Need 5.x to fix: {len(needs_5x)}")
for x in needs_5x:
    print(f"  {x}")
