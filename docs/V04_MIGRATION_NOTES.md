# V0.4 迁移说明

本文说明 Space Model Studio 与旧 “V0.4 GLB metadata import” 的边界、兼容规则和外部 GLB
安全处理方式。它不是对 V0.4 的原地升级脚本。

## 1. 基本边界

- V0.4、Space AI Platform 和 `src/ssp` 均为只读参考，不属于本项目工作区。
- `.sapmodel.json` 是可继续编辑的参数化源文件；任意旧 GLB 不能无损反推为完整 Domain Model。
- GLB 是 Release 或兼容加工产物；导入 GLB 不代表恢复 Wall–Opening 等 Domain 关系。
- 原始文件不得覆盖。输入、工作区和输出必须物理分离：

```text
originals/   # 只读原件
workspaces/  # Studio 编辑状态
outputs/     # 新导出结果
```

## 2. 当前规范与历史兼容

当前唯一规范是 `3.3-semantic`。历史 V0.4 材料曾使用 `3.2-directional`，其中部分 WALL 和
SPACE SID 带方向；这些已交付 artifact 仍可导入，但不在导入时重写。确认的
`WALL_<FLOOR>_PARTITION` 也保持原样。

旧 `.sapmodel.json` 若声明历史 `3.2-directional`，打开时会由版本化兼容迁移步骤进入当前
`3.3-semantic`；自动 WALL/SPACE SID 投影会按新语义字段重新生成，人工 SID 保留供审核，
不会通过字符串替换改写。

| 类型 | 当前 native SID | 兼容说明 |
| --- | --- | --- |
| DOOR/WINDOW/ELEVATOR/STAIR | `<TYPE>_<FLOOR>_<DIR>_<SEQ>` | 方向仍必需 |
| WALL | `WALL_<FLOOR>_<SEQ>` | 历史 directional WALL 可读，不重写；`WALL_<FLOOR>_PARTITION` 可读 |
| SPACE | `SPACE_<FLOOR>_<SPACE_TYPE>_<SEQ>` | 历史 directional SPACE 可读，不重写 |
| FACILITY | `FACILITY_<FLOOR>_<FIRE_TYPE>_<SEQ>` | `fireType` 必需，不使用方向 |
| CEILING | `CEILING_<FLOOR>_<LOWER\|UPPER>` 或 `CEILING_<FLOOR>_SLAB_<SEQ>` | subtype 必需 |

方向只允许 `N/NE/E/SE/S/SW/W/NW`，sequence 从 1 开始且至少两位补零。旧文件名中的数字
不能直接解释成 direction。迁移器只在明确的兼容规则或人工确认下处理字段。

## 3. Metadata 优先级

```text
人工确认值 > 合法 imported metadata > inferred-high > inferred-low > 默认值
```

- `renderTypeMode=manual` 时 suggestion 不能改变 `renderType`。
- 需要方向的类型在 `directionMode=manual` 时必须有 `direction`；WALL、SPACE、FACILITY、
  CEILING 不因缺少方向而失败。
- `sidMode=manual` 时自动流程不能改变 `manualSid`。
- `SPACE.spaceType` 和 `FACILITY.fireType` 是条件必填字段，不能因推断失败而删除。
- 中心点死区不允许给需要方向的实体静默分配 `N`；无法确定时保留人工审核状态。

## 4. 新建模型 Release 路径

```text
.sapmodel.json
  → Domain release validation
  → 每个实体生成一个 semantic node（可复用 meshes[] 定义）
  → 最终 node index 生成 findId
  → GLB 编码
  → 重新解析最终 bytes
  → release validation
  → audit/model-index/sapmodel/逐层 GLB 打包 ZIP
  → 从 ZIP 再次回读
```

`findId` 必须在最终 nodes 数组稳定后生成：

```text
<FLOORNAME>_mesh_<ACTUAL_NODE_INDEX>
```

## 5. 外部 GLB 补空间路径

这条路径把 metadata-only injection 与 geometry enrichment 分开：

1. 保留原始 GLB 及 hash；不得覆盖或在原路径写回。
2. 先 parse/validate 输入，确认 GLB 2.0、单 JSON + 单 BIN、嵌入 buffer、默认 scene、完整
   scene/node metadata、唯一 SID/findId、0 errors 和 0 warnings。
3. 在 Studio 以只读 workspace 打开 GLB；只创建 SPACE Domain entities，不把原 mesh 反推成
   Wall、Door 或其他参数化实体。
4. 为每个 SPACE 生成 `SPACE_<FLOOR>_<SPACE_TYPE>_<SEQ>`、最终-index `findId` 和几何。
5. 以 append-only 方式写出新 GLB：保留原 `nodes`、`meshes`、`accessors`、`bufferViews`、
   `materials`、`scene.nodes` 数组前缀以及 BIN 字节前缀；只追加必要的 entries/data 并更新
   buffer length。
6. 重新 parse、严格 validate，并执行 preservation audit；失败时丢弃新输出，保留原文件。

每个新增 SPACE 应追加一个 node、一个 mesh、两个 accessor、两个 bufferView 和对应 BIN
segment。SID/findId 冲突、非法几何或 source prefix 改变都必须阻止输出。

## 6. A_1F golden 迁移门槛

`/Users/mac/Documents/Codex/SPACE_MODEL_STUDIO/A_1F.glb` 是外部 workflow 的目标输入。补
SPACE 前必须验证为 139 个 semantic mesh nodes；补充 `n` 个 SPACE 后必须验证为
`139 + n` 个 semantic mesh nodes。已经交付的 directional WALL/SPACE 和
`WALL_A_1F_PARTITION` 必须 import-compatible 且 never rewritten。

## 7. 失败处理与非目标

- 不支持把 `MERGED_*`、任意三角网格或父 Group 自动拆回语义实体。
- 不保证恢复门窗宿主、墙参数、楼层复制或撤销历史。
- 不接受 `MESH/OTHER/ROOM/STRUCTURE/UNKNOWN` 作为当前 renderType。
- 不生成全楼 assembled GLB；平台交付按楼层分文件。
- 不修改 Space AI Platform 消费端来迁就不合规输出，也不把语言模型审阅当作 validator。
- 任何需要改变 legacy BIN、bufferView 或 accessor 原数据的操作都超出 metadata 迁移范围；
  外部 SPACE enrichment 只能追加新数据并通过最终验证。
