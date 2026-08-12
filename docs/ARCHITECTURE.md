# Architecture

The editable `Project` domain model is the sole source of truth. UI commands mutate it; viewport geometry is derived; exporters compile each floor independently; post-processing writes final node indices; the emitted GLB is parsed and validated before release success.

The narrow waist is the Space AI Platform GLB Metadata Contract `3.3-semantic`. Strict scene/node
field completeness and unique `sid`/`findId` remain mandatory. One semantic entity/SID maps to one
node, while multiple nodes may share a reusable glTF mesh definition. No consumer implementation is
imported.

There are two production paths:

1. Native `.sapmodel.json` export builds geometry and metadata, assigns final `findId` values, and
   emits a new per-floor GLB.
2. External GLB enrichment parses and validates a read-only source, creates only SPACE entities in a
   Studio workspace, and appends their geometry/metadata to a new GLB. Existing JSON array/node
   prefixes and the original BIN prefix are preserved; only necessary buffer length and appended
   entries/data may change.

The external path is intentionally split into metadata-only injection and geometry enrichment. An
imported GLB is not silently reconstructed as a parameterized Domain model, and an original input is
never overwritten.
