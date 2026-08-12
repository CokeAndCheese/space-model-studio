# `.sapmodel.json` 项目格式规范

状态：Space Model Studio `0.1.x` 的持久化契约  
项目 schema：`1.0.0`  
Metadata 契约：`3.3-semantic`

`.sapmodel.json` 是可继续编辑的唯一源文件；GLB、`model-index.json` 和
`audit-report.json` 都是可重新生成的 Release 产物。Three.js 场景、Vue 状态、
选中对象和相机位置不属于本格式，也不能成为业务事实来源。

本规范中的“必须”是写入和打开项目时的强制条件。实现以
`src/domain/contract.ts`、`src/domain/project-schema.ts` 和
`src/domain/project-serializer.ts` 为准。

## 1. 文件与兼容策略

- 文件名后缀必须为 `.sapmodel.json`；内容编码为 UTF-8 JSON。
- 顶层 `schemaVersion` 必须精确等于 `1.0.0`。
- 顶层 `metadataSpecVersion` 必须精确等于 `3.3-semantic`。
- 所有对象均使用严格 schema；未知字段会导致打开失败，不能被静默丢弃。
- 所有 ID 都是 UUID，并在对应的项目范围内保持唯一。
- 日期使用合法 ISO-8601 datetime 字符串。
- 所有长度在 Domain Model 内统一使用米；没有隐式单位换算。
- 当前版本不对未知 schema 做“尽力打开”。未来格式升级必须通过显式迁移器完成。

## 2. 顶层 Project

```json
{
  "schemaVersion": "1.0.0",
  "metadataSpecVersion": "3.3-semantic",
  "projectId": "a4131176-a72a-465c-af54-f4ac206aad65",
  "name": "Demo Hospital",
  "settings": {
    "unit": "m",
    "upAxis": "+Y",
    "north": { "x": 0, "z": -1 },
    "gridSize": 0.1,
    "snapEnabled": true
  },
  "buildings": [],
  "createdAt": "2026-08-04T08:00:00.000Z",
  "updatedAt": "2026-08-04T08:00:00.000Z"
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `schemaVersion` | string | 固定为 `1.0.0` |
| `metadataSpecVersion` | string | 固定为 `3.3-semantic` |
| `projectId` | UUID | 项目标识，保存/回读时不改变 |
| `name` | string | 去除首尾空白后 1–200 字符 |
| `settings` | object | 见下节 |
| `buildings` | `Building[]` | 楼栋集合 |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 最近一次持久化/领域修改时间 |

### 2.1 坐标与项目设置

- `unit` 固定为 `m`。
- `upAxis` 固定为 `+Y`。
- 建筑编辑平面是 XZ：`+X` 为东，默认 `-Z` 为北。
- `north` 是任意非零有限向量；方向计算前会归一化，因此不要求输入长度为 1。
- `gridSize` 必须为有限正数。
- `snapEnabled` 必须为布尔值。

## 3. Building 与 Floor

### 3.1 Building

```json
{
  "id": "d6add0b6-b5ad-42de-8e24-730fb2d11069",
  "code": "A",
  "name": "A栋",
  "floors": []
}
```

- `id` 是 UUID，项目内唯一。
- `code` 匹配 `^[A-Z][A-Z0-9]*$`，项目内唯一。
- `name` 为 1–200 字符的人类可读名称。

### 3.2 Floor

```json
{
  "id": "d44294fc-1c67-4b27-82bc-5354d36cfe84",
  "buildingId": "d6add0b6-b5ad-42de-8e24-730fb2d11069",
  "floorName": "A_1F",
  "name": "A栋1层",
  "level": 1,
  "floorType": "FLOOR",
  "elevation": 0,
  "clearHeight": 3.6,
  "entities": []
}
```

- `id` 和 `floorName` 在整个项目内唯一，而不只是楼栋内唯一。
- `floorName` 匹配 `^[A-Z0-9][A-Z0-9_-]*$`，最长 100 字符。
- `elevation` 是该层地面相对项目原点的 Y 坐标。
- `clearHeight` 必须为有限正数。
- `floorType` 只能是 `FLOOR`、`TOWER`、`ROOF`、`BASEMENT`、
  `LANDSCAPE_TERRAIN`、`LANDSCAPE_FACADE` 或 `FACILITY`。
- 普通楼层的 `buildingId` 必须等于其父楼栋 ID，`level` 必须是非零整数。
- 景观楼层的 `buildingId` 和 `level` 必须同时为 `null`。

## 4. 实体公共契约

每个实体至少包含：

```json
{
  "id": "c5e83f97-e13b-463b-99ca-f8599ea435b8",
  "kind": "wall",
  "floorId": "d44294fc-1c67-4b27-82bc-5354d36cfe84",
  "name": "北侧外墙",
  "visible": true,
  "locked": false,
  "transform": {
    "position": { "x": 0, "y": 0, "z": -4 },
    "rotationY": 0
  },
  "metadata": {
    "renderType": "WALL",
    "confidence": "confirmed",
    "sidMode": "auto",
    "directionMode": "auto",
    "renderTypeMode": "manual",
    "sequence": 1
  }
}
```

公共约束：

- `id` 是项目内全局唯一 UUID。
- `floorId` 必须等于实体所在 Floor 的 ID；跨层引用不合法。
- `name` 去除首尾空白后为 1–200 字符。
- transform 中所有数值必须为有限数。
- `renderType` 必须与 `kind` 的固定映射一致：

| `kind` | `renderType` |
| --- | --- |
| `wall` | `WALL` |
| `slab`, `ceiling` | `CEILING` |
| `door` | `DOOR` |
| `window` | `WINDOW` |
| `space` | `SPACE` |
| `facility` | `FACILITY` |
| `stair` | `STAIR` |
| `elevator` | `ELEVATOR` |

### 4.1 Metadata

| 字段 | 合法值与语义 |
| --- | --- |
| `renderType` | 八种固定枚举之一，并与 `kind` 一致 |
| `confidence` | `confirmed`、`imported`、`inferred-high`、`inferred-low` |
| `sidMode` | `auto` 或 `manual` |
| `directionMode` | `auto` 或 `manual` |
| `renderTypeMode` | `auto` 或 `manual` |
| `direction` | 可选；仅 DOOR/WINDOW/ELEVATOR/STAIR 的 SID 必须使用 `N/NE/E/SE/S/SW/W/NW` |
| `sequence` | 从 1 开始的正整数，持久化且不会在普通导出时重排 |
| `sid` | 可选的持久化预览/兼容值 |
| `manualSid` | 人工 SID；`sidMode=manual` 时优先使用 |
| `sub` | CEILING subtype，例如 `UPPER`、`LOWER`、`SLAB_01` |

当 `renderType` 为 DOOR、WINDOW、ELEVATOR 或 STAIR 且 `directionMode=manual` 时必须存在
`direction`；WALL、SPACE、FACILITY 和 CEILING 不因缺少 direction 而非法。`sidMode=manual`
时必须存在 `manualSid` 或兼容字段 `sid`。自动推断不得覆盖 manual 字段或人工确认值。

### 4.2 SID grammar

| 类型 | SID 形式 | 方向/子类型要求 |
| --- | --- | --- |
| DOOR、WINDOW、ELEVATOR、STAIR | `<TYPE>_<FLOOR>_<DIRECTION>_<SEQ>` | 必须有方向 |
| WALL | `WALL_<FLOOR>_<SEQ>` | 不需要方向 |
| SPACE | `SPACE_<FLOOR>_<SPACE_TYPE>_<SEQ>` | 必须有 `spaceType`，不需要方向 |
| FACILITY | `FACILITY_<FLOOR>_<FIRE_TYPE>_<SEQ>` | 必须有 `fireType`，不需要方向 |
| CEILING | `CEILING_<FLOOR>_<LOWER\|UPPER>` 或 `CEILING_<FLOOR>_SLAB_<SEQ>` | 必须有 subtype |

`SEQ` 从 1 开始，至少两位补零；删除不会立即回收已发出的 sequence。已交付的
directional WALL/SPACE 以及 `WALL_<FLOOR>_PARTITION` 是 import-compatible 的历史产物，
不在导入时重写。

## 5. 参数化实体

下表列出公共字段之外的必需数据。所有尺寸都必须为有限正数，除非另行说明。

| `kind` | 主要字段 | 额外约束 |
| --- | --- | --- |
| `wall` | `start`, `end`, `baseOffset`, `height`, `thickness`, `openings[]` | 直墙长度必须大于 0.1m；`openings` 不重复 |
| `door` | `hostWallId`, `offset`, `width`, `height`, `depth`, `sillHeight: 0` | 必须宿主于同层墙体；不能越界或与同墙洞口重叠 |
| `window` | `hostWallId`, `offset`, `width`, `height`, `depth`, `sillHeight` | 与门相同，且 `sillHeight >= 0` |
| `slab` | `polygon`, `baseOffset`, `thickness` | `polygon` 至少 3 个有效点、面积非零且不自交 |
| `ceiling` | `polygon`, `height`, `thickness` | 同样的合法多边形约束；`height >= 0` |
| `space` | `polygon`, `height`, `spaceType` | 合法多边形；`spaceType` 必须属于规范枚举 |
| `facility` | `facilityShape`, `size`, `position`, `mountHeight`, `fireType` | shape 为 `box/cylinder/icon`；`mountHeight >= 0` |
| `stair` | `start`, `end`, `width`, `totalRise`, `stepCount`, `position`, `length`, `height` | `stepCount >= 2`；别名字段由领域命令同步 |
| `elevator` | `center`, `position`, `width`, `depth`, `height` | `center` 与 `position.x/z` 由领域命令同步 |

`spaceType` 合法值：`TOILET`、`LAUNDRY`、`KITCHEN`、`OFFICE`、
`MEETING_ROOM`、`BEDROOM`、`CORRIDOR`、`STAIRWELL`、`ELEVATOR_HALL`、
`MECHANICAL_ROOM`、`STORAGE`、`LOBBY`、`BALCONY`。

`fireType` 合法值：`HYDRANT`、`SMOKE_DETECTOR`、`SPRINKLER`、
`EXTINGUISHER`、`EMERGENCY_LIGHT`、`EXIT_SIGN`、`BREAK_GLASS`、
`ALARM_BELL`、`FIRE_HOSE`、`FIRE_DOOR`、`OTHER`。

## 6. 引用完整性

打开、保存和 Domain 命令提交时必须检查：

1. Building ID/code、Floor ID/name、Entity ID 均满足各自唯一性。
2. 实体只能属于其数组所在楼层。
3. Door/Window 的 `hostWallId` 必须指向同层 Wall。
4. Wall 的 `openings` 必须完整、无重复，且与每个 Door/Window 的反向宿主引用一致。
5. 洞口水平区间必须位于墙长内；`sillHeight + height` 不得超过墙高。
6. 同墙洞口区间不得重叠。
7. 删除带洞口墙体必须显式选择级联删除，不能静默遗留孤儿洞口。

## 7. 保存、打开与复制

`serializeProject(project)` 的行为：

1. 深拷贝调用方数据。
2. 对副本执行完整严格 schema 与关系校验。
3. 仅更新副本的 `updatedAt`。
4. 输出格式化 JSON，不修改调用方内存对象。

`parseProject(text)` 先解析 JSON，再执行相同的严格 schema 与关系校验。解析失败、
版本不匹配、未知字段或引用损坏都会抛出 `ProjectFormatError`，并携带可定位的问题路径。

复制楼层时必须生成新的 Floor/Entity UUID，重映射 Wall–Opening 引用，并根据新
`floorName` 生成自动 SID。相对参数化几何保持不变，目标 `elevation` 明确保存。WALL 和
SPACE 的自动 SID 不依赖方向。

## 8. 与 Release 产物的关系

每个 Floor 独立编译为 `<floorName>.glb`。一个 Domain 语义实体必须对应一个
`node.mesh !== undefined` 的 GLB node；多个 node 可以复用同一个 `meshes[]` 定义。GLB 中的
node index 与 `findId` 是编译结果，不得写回项目作为实体身份。

外部 GLB 补空间不把 GLB 转换成 `.sapmodel.json`：输入先严格 parse/validate，Studio 只读
显示原模型并在 Domain 中创建 SPACE。导出时 append-only 追加 SPACE 的 geometry 和 metadata，
保留原 arrays/nodes、scene.nodes 和 BIN 前缀，输出到新文件；原始输入永不覆盖。

完整 Release ZIP 包含：

```text
A_1F.glb
A_2F.glb
model-index.json
audit-report.json
Demo Hospital.sapmodel.json
```

Release 成功必须建立在最终 ZIP 所包含 GLB 的回读验证上，而不是只验证内存 JSON。

## 9. Demo Hospital 验收基线

标准验收项目包含 Building A 的 `A_1F` 与 `A_2F`。每层 13 个语义实体：

- 4 Wall
- 1 Door
- 2 Window
- 1 Slab 与 1 Ceiling
- 1 OFFICE Space
- 1 HYDRANT Facility
- 1 Stair
- 1 Elevator

位于楼层中心死区的 OFFICE Space 不能由算法随意指定方位；验收数据将其方位人工确认
为 `N` 后再复制楼层。两层合计 26 个实体，项目回读后所有 ID、宿主引用、语义字段与
参数化数据必须保持一致。
