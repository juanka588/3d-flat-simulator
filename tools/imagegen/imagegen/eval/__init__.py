"""Offline coherence evaluation of restyled interior images (CG restyle spike tooling).

`python -m imagegen.eval {score,sheet,inputs,generate}`; see docs/research/cg-restyle-spike.md. The pure maths lives in
`maths.py` (numpy + scipy only, unit-tested); the three small models are loaded lazily by `models.py` (extra `eval`).
"""
