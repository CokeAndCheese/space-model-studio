# Product scope

Demo-focused semantic building editor for walls, slabs, ceilings, doors, windows, spaces, stairs, elevators, and facilities. It saves `.sapmodel.json`, exports one GLB per floor, and produces deterministic validation and audit reports under the `3.3-semantic` contract. It also supports a read-only external GLB workspace that adds SPACE entities and writes an append-only enriched GLB. It is not a general mesh, BIM conversion, arbitrary GLB-to-Domain reconstruction, or collaborative authoring tool.

The native path and external enrichment path are separate acceptance surfaces. External enrichment
must preserve the source arrays/nodes and BIN prefix, emit a new file, and pass final parse/validation;
metadata-only injection must not be described as geometry conversion.
