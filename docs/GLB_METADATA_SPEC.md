# GLB Metadata Contract 3.3-semantic

`3.3-semantic` is the current contract. The Domain Model is authoritative for native
exports; imported metadata is retained when valid, and confirmed human metadata always
has precedence over imported, inferred, or default values.

## Required scene and node metadata

`scene.extras` contains only floor metadata:

```json
{
  "floorName": "A_1F",
  "building": "A",
  "level": 1,
  "floorType": "FLOOR",
  "name": "A栋1层"
}
```

Every reachable node with `node.mesh !== undefined` is one semantic node and requires:
`sid`, `findId`, `floorName`, `building`, `level`, `floorType`, `name`,
`renderType`, and `renderTypeConfidence`. Its redundant floor fields must equal
`scene.extras`. `SPACE` additionally requires `spaceType`; `FACILITY` additionally
requires `fireType`. Non-mesh nodes must not carry `sid` or `renderType`.

One semantic entity/SID maps to exactly one node. Multiple nodes may reference the same
reusable `meshes[]` definition. `findId` is assigned after final node ordering:

```text
<FLOORNAME>_mesh_<ACTUAL_NODE_INDEX>
```

## SID grammar

Sequences are positive integers rendered with a minimum width of two digits (`01`, `02`,
…, `100`). Direction is one of `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`.

| Render type | SID grammar | Required semantic field |
| --- | --- | --- |
| `DOOR`, `WINDOW`, `ELEVATOR`, `STAIR` | `<TYPE>_<FLOOR>_<DIRECTION>_<SEQ>` | `direction` |
| `WALL` | `WALL_<FLOOR>_<SEQ>` | none |
| `SPACE` | `SPACE_<FLOOR>_<SPACE_TYPE>_<SEQ>` | `spaceType` |
| `FACILITY` | `FACILITY_<FLOOR>_<FIRE_TYPE>_<SEQ>` | `fireType` |
| `CEILING` | `CEILING_<FLOOR>_<LOWER\|UPPER>` or `CEILING_<FLOOR>_SLAB_<SEQ>` | ceiling subtype |

Examples:

```text
DOOR_A_1F_E_01
WALL_A_1F_01
WALL_A_1F_PARTITION
SPACE_A_1F_OFFICE_01
FACILITY_A_1F_HYDRANT_01
CEILING_A_1F_LOWER
CEILING_A_1F_SLAB_02
```

`WALL_<FLOOR>_<SEQ>` is the native form. Already-delivered directional WALL/SPACE
artifacts and the confirmed `WALL_<FLOOR>_PARTITION` form remain import-compatible; they
are not rewritten merely to normalize their SID.

## Two production paths

Native `.sapmodel.json` export creates the floor geometry and metadata, assigns final
`findId` values, writes a new GLB, and parses/validates the emitted bytes again.

External GLB enrichment is metadata-only injection plus geometry enrichment for new
SPACE entities. It first parses and strictly validates the source, then appends the new
SPACE material, bufferViews, accessors, meshes, nodes, and aligned BIN segments. Source
arrays/nodes and the source BIN prefix are preserved; only the necessary buffer length
and appended data/entries change. The source file is never overwritten.

Both paths require unique SID/findId values, complete node metadata, zero errors and
warnings, and a successful final parse. See [validation rules](VALIDATION_RULES.md),
[acceptance tests](ACCEPTANCE_TESTS.md), and [V0.4 migration notes](V04_MIGRATION_NOTES.md).
