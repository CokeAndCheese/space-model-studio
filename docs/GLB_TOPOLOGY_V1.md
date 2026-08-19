# GLB Embedded Topology V1

Space Model Studio stores topology authoring data in the editable `*.sapmodel.json` Domain Model. GLB remains an export artifact. A valid effective graph is embedded only during Release export at `scene.extras.sspTopology`; imported source files are never overwritten.

## Contract

- `schemaVersion`: `1`
- `coordinateSpace`: `MODEL_LOCAL`
- `graphs[]`: structurally compatible with Space AI Platform `TopologyGraphInput`
- Node positions and edge `path.via` points are model-local finite coordinates.
- Existing scene extras and semantic node metadata are preserved.

Each floor produces one graph. Every route-relevant semantic entity (`SPACE`, `DOOR`, `STAIR`, `ELEVATOR`, `FACILITY`) produces exactly one node. Same-floor edges are deterministic candidates created from an MST connectivity backbone plus bounded K-nearest-neighbor alternatives.

## Authoring boundary

The generated baseline is immutable. Human changes are persisted as sparse edits in `Project.topology`: added nodes/edges, deleted/restored items, node position and connector changes, and edge via-path changes. The effective graph is derived by applying edits to a copy of the baseline. Because this state belongs to the Domain Model, save/open and project undo/redo use the existing Studio history and serializer.

The effective graph is also projected into the main Three.js model viewport in `MODEL_LOCAL` coordinates. Nodes and complete edge polylines (source, via points, target) remain visible over the GLB in both plan and perspective modes. The overlay can be hidden independently; clicking an overlaid node or path opens the topology workspace and selects that authored item.

`connectorId` is diagnosed for stairs and elevators but Studio does not guess cross-floor connections. This release does not claim building-level cross-floor pathfinding.

## Release acceptance

Release is rejected when graph IDs, node IDs or edge IDs collide; endpoints or layers are missing; coordinates are non-finite; an edge is self-referential; adjacent path points are effectively equal; or a multi-node graph is disconnected/isolated. After embedding, the emitted GLB is parsed again and its `sspTopology` is validated with the same validator used by authoring.

Runtime model-local-to-world conversion, SSP rendering/pathfinding, AI asset subscriptions, query templates, and AI runtime override semantics remain Space AI Platform responsibilities and are not included in Studio.
