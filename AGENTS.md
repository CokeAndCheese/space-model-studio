# Space Model Studio guardrails

- `*.sapmodel.json` is the editable source; GLB is an export artifact.
- The project Domain Model is the only source of truth. Three.js objects are projections.
- One semantic entity with one SID exports to exactly one mesh node.
- Confirmed human metadata always wins over imported, inferred, or default metadata.
- Metadata contract is `3.3-semantic`. WALL and SPACE do not require direction;
  direction remains required for directional opening/vertical-transport entities.
- One semantic entity/SID still exports to one mesh node, but multiple glTF nodes
  may share the same reusable `meshes[]` definition.
- `V0.4 GLB metadata import` is managed inside this workspace; keep its standalone port-8002 boundary and avoid coupling its inference logic into the Studio Domain Model.
- Never modify Space AI Platform or `src/ssp` from this project.
- Never overwrite imported originals. Use originals, workspaces, and outputs separately.
- A release export is successful only after the emitted GLB is parsed and validated again.
