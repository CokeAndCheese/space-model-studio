# 初版验收测试与证据

本文定义 Space Model Studio 初版的可重复验收门槛。权威自动化场景位于
`tests/acceptance.test.ts`；它不使用 mock GLB，也不把待打包的源 entry 列表当作最终
ZIP 证据，而是重新读取实际生成的 `.sapmodel.json`、GLB 和 ZIP bytes。

## 1. 一键验收

```bash
npm test
npm run build
```

只运行完整 Release 链路：

```bash
npm test -- --run tests/acceptance.test.ts
```

任一命令非零退出即表示验收失败。测试不更新 golden 文件，也没有“自动接受”模式。

## 2. 固定验收数据

```text
Demo Hospital
└── Building A
    ├── A_1F  elevation 0.0m
    └── A_2F  elevation 4.2m
```

每层包含 13 个实体：4 Wall、1 Door、2 Window、1 Slab、1 Ceiling、1 OFFICE Space、
1 HYDRANT Facility、1 Stair、1 Elevator。两层合计 26 个实体，覆盖全部八种
`renderType`。原生导出中 Wall 使用无方向 SID，OFFICE Space 使用无方向 SID。

Door/Window/Elevator/Stair 的方向由自动计算或人工确认提供；WALL、SPACE、FACILITY、CEILING
不要求 direction。中心死区只对需要方向的实体产生人工确认或 validation issue。

## 3. 自动化验收矩阵

| ID | 门槛 | 权威证据 |
| --- | --- | --- |
| AC-01 | Demo Hospital 有 A_1F/A_2F 两层 | 回读项目的 `floorName` 精确等于 `A_1F`, `A_2F` |
| AC-02 | 楼层复制完整 | 每层 13 个实体、两层 Entity UUID 共 26 个且全部唯一 |
| AC-03 | 项目可保存并重新打开 | `serializeProject` 输出经 `parseProject` 回读后与持久化 JSON 深度相等 |
| AC-04 | Domain release 合法 | `validateProject(..., 'release')` 返回 1 building、2 floors、26 entities、0 errors、0 warnings |
| AC-05 | 逐层 GLB 导出与回读 | A_1F/A_2F 分别调用 `exportFloorToGlb`，再独立调用 `parseGlb` 与 `validateGlb` |
| AC-06 | 一实体一 node | 每个 GLB 恰好 13 个 semantic mesh nodes，与该层 Domain entity 数一致；可复用 `meshes[]` 定义 |
| AC-07 | Metadata 覆盖 100% | 两个最终 GLB 的 `metadataCoverage` 都是 100，合并审计也为 100 |
| AC-08 | 单文件无冲突 | 每个 GLB 的 `sidDuplicates=0`、`findIdDuplicates=0` |
| AC-09 | 整包无冲突 | 从两个回读 GLB 收集 26 个 SID/findId；两个 Set 的 size 均为 26 |
| AC-10 | Semantic SID 使用新契约 | 明确检查 directional DOOR、无方向 WALL/SPACE、FACILITY 代表性 SID |
| AC-11 | 审计报告闭环 | 合并报告精确满足 2 files、26 meshes、26 SID、26 findId、0 duplicates、0 errors/warnings |
| AC-12 | ZIP 交付物完整 | 从最终 ZIP local records 提取并精确比对 5 个 entry 名称 |
| AC-13 | ZIP 内容可用 | 从 ZIP 再打开 sapmodel、model-index、audit，并再次解析/验证两个 GLB |

## 4. 期望审计摘要

```json
{
  "files": 2,
  "meshNodes": 26,
  "sidCount": 26,
  "findIdCount": 26,
  "sidDuplicates": 0,
  "findIdDuplicates": 0,
  "metadataCoverage": 100,
  "reloadSuccess": true,
  "errors": 0,
  "warnings": 0
}
```

合计 `renderTypeCounts`：

```json
{
  "CEILING": 4,
  "WALL": 8,
  "DOOR": 2,
  "WINDOW": 4,
  "ELEVATOR": 2,
  "STAIR": 2,
  "SPACE": 2,
  "FACILITY": 2
}
```

验收测试同时锁定以下代表性 SID：

```text
DOOR_A_1F_E_01
WALL_A_1F_01
SPACE_A_1F_OFFICE_01
FACILITY_A_1F_HYDRANT_01
DOOR_A_2F_E_01
SPACE_A_2F_OFFICE_01
FACILITY_A_2F_HYDRANT_01
```

## 5. External A_1F golden acceptance

The target input is `/Users/mac/Documents/Codex/SPACE_MODEL_STUDIO/A_1F.glb`. It is an external
read-only input, not a project source and never an output path. Before adding SPACE, the input must:

```bash
npm exec vite-node scripts/audit-external-glb.ts -- /Users/mac/Documents/Codex/SPACE_MODEL_STUDIO/A_1F.glb
```

The audit command is an inspection gate; it does not modify the input.

- parse as GLB 2.0 and pass strict validation with zero errors and zero warnings;
- contain exactly 139 semantic mesh nodes with complete metadata and unique SID/findId values;
- preserve already-delivered directional WALL/SPACE metadata and confirmed `WALL_A_1F_PARTITION`;
- pass the same scene/node field completeness gates as a native release.

The enrichment scenario creates one or more SPACE entities in Studio. For `n` new SPACE entities,
the output must have `139 + n` semantic mesh nodes. It must append one node and one reusable mesh
definition per SPACE, with two new accessors and two new bufferViews per SPACE, and preserve the
source `nodes`, `meshes`, `accessors`, `bufferViews`, `materials`, `scene.nodes`, and BIN prefixes.
The source file and source bytes must remain unchanged. The emitted GLB is parsed and validated
again before it can be accepted.

## 6. Release ZIP 清单

最终 ZIP 必须恰好包含：

```text
A_1F.glb
A_2F.glb
Demo Hospital.sapmodel.json
audit-report.json
model-index.json
```

测试会检查 ZIP End of Central Directory 的 entry 数量为 5，并从 local file records
读取真实文件名和未压缩数据。随后：

1. `Demo Hospital.sapmodel.json` 再次通过严格项目解析。
2. `model-index.json` 精确列出 A_1F 与 A_2F，且每层 13 meshes、`valid=true`。
3. `audit-report.json` 的 summary 与内存合并审计逐字段相同。
4. 两个打包后的 GLB 再次达到 release 0 error、0 warning、100% metadata。

## 7. 失败判定

以下任一情况都必须阻止 Release，不允许仅显示 warning 后继续下载：

- 项目 schema、宿主引用、洞口范围或多边形不合法。
- 需要方向的实体在中心死区内却没有人工确认方向。
- 任一最终 GLB 解析失败、结构引用越界或 mesh/entity 数量不一致。
- 任一 mesh node 缺 SID、findId、renderType、冗余楼层字段或条件语义字段。
- 单文件或跨楼层存在重复 SID/findId。
- Metadata 覆盖率低于 100%。
- 任一审计 error 或 warning 非零。
- ZIP 少文件、多文件、重名、内容无法回读，或 index/audit 与真实 GLB 不一致。

## 8. UI 人工冒烟清单

自动化验收覆盖确定性数据链路。发布 Demo 前还应在浏览器进行一次 UI 冒烟，不用它替代
上述自动测试：

1. 打开默认 Demo Hospital，切换 A_1F/A_2F。
2. 在 2D/3D 间切换，点击“适配视图”，确认可见对象与选择同步。
3. 新建墙、门、窗和语义对象，确认项目树及属性面板更新。
4. 保存 `.sapmodel.json`，刷新页面后重新打开。
5. 点击“验证”，Issues 为 0 errors / 0 warnings。
6. 导出 Release ZIP，并用本节清单核对下载内容。

人工冒烟发现的问题应单独记录；未执行人工冒烟不能被写成“UI 已验证”。

## 9. 最近一次验收记录

验证日期：2026-08-04  
运行环境：Node `v22.22.2`、npm `10.9.7`

| 命令 | 结果 |
| --- | --- |
| `npm test` | 通过：10 test files、49 tests；包含 1 个完整 Release acceptance test |
| `npm run typecheck` | 通过：`vue-tsc -b` 退出码 0 |
| `npm run build` | 通过：53 modules transformed，生成 `dist/index.html` 与 CSS/JS assets |

本次 acceptance 实测与第 4 节完全一致：2 GLB、26 meshes、26 SID、26 findId、
0 SID/findId duplicates、100% metadata、reload success、0 errors、0 warnings；ZIP 的 5 个
entry 均从最终 bytes 中重新提取并回读。

Vite 另有一个 729.65 kB JS chunk 的体积优化提示。它是前端性能 advisory，不是 Domain
或 GLB release validator 的 warning，未影响构建退出码；后续可用路由/Three.js 动态加载
做代码分割。这里明确记录，不能把它与模型验收的 `warnings=0` 混淆。

每次准备交付都应更新日期、Node/npm 版本、测试统计和构建结果。若与本规范期望数字不
一致，应视为验收失败，直到实现或规范经过明确评审。
