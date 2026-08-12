# GLB release validation rules

Space Model Studio treats `.sapmodel.json` as the editable source and GLB as a compiled artifact. A floor export is returned to the UI only after the emitted bytes are parsed again and pass the rules below with zero errors and zero warnings.

## Container and glTF graph

- The 12-byte header must contain `glTF`, version `2`, and the exact physical file length.
- The first and only JSON chunk and the optional single BIN chunk must be 4-byte aligned and remain within file bounds.
- `asset.version` must be `2.0`; a release file uses one embedded buffer and one primary scene.
- Buffers, bufferViews, accessors, node children, mesh references, POSITION accessors, and index accessors must resolve and remain within their parent byte ranges.
- Each semantic entity maps to exactly one semantic node. Multiple nodes may reference the same reusable `meshes[]` definition; node count, not unique mesh-definition count, must equal the number of Domain entities in a native floor export.
- An external SPACE export must preserve the source node/scene-node prefixes and append exactly one node and one mesh definition per added SPACE.

## Scene metadata

`scene.extras` contains only floor-level metadata:

```json
{
  "floorName": "A_1F",
  "building": "A",
  "level": 1,
  "floorType": "FLOOR",
  "name": "A栋1层"
}
```

It must not contain `sid`, `findId`, `renderType`, `spaceType`, or `fireType`.

## Mesh-node metadata

Every node with `node.mesh !== undefined` requires `sid`, `findId`, `floorName`, `building`, `level`, `floorType`, `name`, `renderType`, and `renderTypeConfidence`. The redundant floor fields must equal `scene.extras`. `SPACE` also requires `spaceType`; `FACILITY` also requires `fireType`.

The final identifier is calculated only after the nodes array has its final order:

```text
<FLOORNAME>_mesh_<ACTUAL_NODE_INDEX>
```

Editor correlation fields such as `_editorEntityId` are removed before packing.

## SID and coverage gates

- SID must match the `3.3-semantic` contract, the node `renderType`, and the node `floorName`.
- `DOOR`, `WINDOW`, `ELEVATOR`, and `STAIR` use one of `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, or `NW`, followed by a positive sequence.
- `WALL` uses `WALL_<FLOOR>_<SEQ>`; `SPACE` uses `SPACE_<FLOOR>_<SPACE_TYPE>_<SEQ>` and does not require direction.
- `FACILITY` includes `fireType` and omits direction; `CEILING` uses its subtype and omits direction.
- Already-delivered directional WALL/SPACE and confirmed `WALL_<FLOOR>_PARTITION` artifacts are accepted for import and are not rewritten.
- SID and findId must each be unique inside the final file.
- Metadata coverage is `complete semantic mesh nodes / all mesh nodes`. A Space Model Studio release requires `100%`.
- Non-mesh nodes may not carry `sid` or `renderType`.

## External GLB append-only gates

The external path is valid only when all of the following hold:

1. The source GLB parses as GLB 2.0, has one JSON chunk followed by one BIN chunk, one embedded buffer, one default scene, complete scene metadata, and zero validation warnings.
2. The source `floorName`, `floorType`, and `level` match the selected Studio floor; the source is treated as read-only.
3. Only SPACE entities are appended. Each receives a unique semantic SID, a final-index `findId`, one node, one mesh definition, two accessors, two bufferViews, and geometry with valid POSITION/index ranges.
4. The source prefixes of `nodes`, `meshes`, `accessors`, `bufferViews`, `materials`, `scene.nodes`, and BIN bytes are byte/JSON-equivalent in the output.
5. The output updates the embedded buffer length only as needed and passes a fresh parse, strict validation, and preservation audit. The original file and source bytes remain unchanged.

For the A_1F golden input, the pre-enrichment gate is exactly 139 semantic mesh nodes. If
`n` SPACE entities are added, the output must contain `139 + n` semantic mesh nodes and
must pass all final gates below.

## Audit report

`exportFloorToGlb(project, floorId)` returns the GLB bytes and an `auditReport`. The report records byte size, reloaded scene metadata, mesh/SID/findId counts, duplicate counts, render-type counts, coverage, reload state, errors, and warnings. Release success means:

```text
errors = 0
warnings = 0
sidDuplicates = 0
findIdDuplicates = 0
metadataCoverage = 100
reloadSuccess = true
```
