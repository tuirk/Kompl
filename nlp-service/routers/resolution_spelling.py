"""British and American spellings of one word, for the stored-alias lookup.

Layer 1 looked up stored aliases by the exact lower-case name, so
"colorblindness" missed the alias "Colour-blindness" of the page "Color
Vision Deficiency", Layer 3 was asked instead and kept the two apart (film
run, 2026-10-25). The lookup now reads both through the page-title skeleton
(routers/resolution.py _alias_key) after us_spelling below.

Two rewrites, each only where three or more letters come before the ending,
so short words keep their own spelling:
  - "our" → "or": colour, behaviour, honour, colourblindness; never tour,
    four, hour, flour, your, pour or sour;
  - "is" → "iz" before e/es/ed/er/ers/ing/ation/ations/ational, after a
    consonant: organise, realised, visualising, organisation; never raise,
    praise, noise, cruise, maize (a vowel before) or prise (two letters).
A word that only looks like one of these (contour → "contor", promise →
"promize") is rewritten too, but matches only a name spelt that way.

Pure functions on strings; nothing here imports the router.
"""

from __future__ import annotations

import re

_OUR = re.compile(r"(?<=[^\W\d_]{3})our")
_ISE = re.compile(r"(?<=[^\W\d_]{2}[bcdfghjklmnpqrstvwxz])is(?=(?:e|es|ed|er|ers|ing|ation|ations|ational)\b)")


def us_spelling(text: str) -> str:
    """`text` in lower case with British -our and -ise spellings written the
    American way: "Colour-blindness" → "color-blindness", "Organisation"
    → "organization"."""
    return _ISE.sub("iz", _OUR.sub("or", text.lower()))
