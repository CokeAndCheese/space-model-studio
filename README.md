# Space Model Studio

Space Model Studio 是面向 Space AI Platform 的轻量、语义优先建筑建模器。它用
`.sapmodel.json` 保存可继续编辑的参数化项目，并把每个楼层编译成符合
`3.3-semantic` Metadata 契约的独立 GLB。

当前初版包含可运行的 Vue 3 / Three.js 工作台、完整 Domain 数据契约、九类参数化实体、
项目保存回读、逐层 GLB 编译、Release 校验、审计报告、ZIP 交付链路，以及已验收 V0.4
“GLB模型数据注入”工具的独立入口。

## 运行

环境建议：Node.js 20 或更高版本、npm 10 或更高版本。

```bash
npm install
npm run dev
```

Vite 会输出本地访问地址。生产构建：

```bash
npm run build
```

## 验证

```bash
npm test
npm run typecheck
npm run build
```

完整的两层 Demo Hospital Release 验收可以单独运行：

```bash
npm test -- --run tests/acceptance.test.ts
```

该场景会真实执行：

```text
Demo Hospital 两层 Domain Model
  → .sapmodel.json 序列化与回读
  → A_1F.glb / A_2F.glb 独立导出
  → 最终 GLB bytes 重新解析和 release 校验
  → model-index + audit + sapmodel 打包 ZIP
  → 从最终 ZIP 再次提取并回读所有交付物
```

验收基线是 2 层、26 个 semantic mesh nodes、26 个 SID、26 个 findId、100% metadata、
0 duplicates、0 errors、0 warnings。外部 `A_1F.glb` golden 输入在补 SPACE 前应通过
严格校验并包含 139 个 semantic mesh nodes。

## 初版功能

- 新建、打开和保存 `.sapmodel.json` 项目。
- Project/Building/Floor/Entity 全层级选择与右键菜单，支持新增单体、新增/复制楼层和带确认的级联删除。
- 2D 俯视与 3D 透视视口、选择、高亮、网格吸附和适配视图；支持空白清选、左到右完全包含框选、右到左相交框选。
- 墙体采用连续两点绘制：点击确定起点，再次点击确定终点并生成墙体；下一段自动从上一段终点继续，按 `Esc` 退出绘制。
- 墙体绘制支持网格、既有墙体端点和 X/Z 轴向对齐吸附；轴向命中时显示可视化虚线对齐辅助线，按住 `Alt` 可临时关闭吸附。
- 墙体中心线形成简单封闭区域时，自动识别 Space 并补齐对应地板与天花；既有覆盖对象优先，不重复生成。
- 创建和编辑 Wall、Door、Window、Slab、Space、Facility、Stair、Elevator；Demo 也包含
  Ceiling。
- Wall–Door/Window 双向宿主引用、洞口边界/重叠约束和墙体分段几何。
- Undo/Redo、删除、显示、锁定和基础属性编辑。
- 八方位计算、自定义北向、稳定 sequence 与按实体类型生成的 semantic SID；DOOR、WINDOW、
  ELEVATOR、STAIR 使用方向，WALL 和 SPACE 不要求方向，FACILITY 与 CEILING 使用 subtype。
- 人工 metadata 优先，不允许推断静默覆盖 manual/confirmed 值。
- 每个语义实体导出为一个 GLB node；多个 node 可以复用同一个 `meshes[]` 定义，`findId` 使用最终
  node index。
- GLB header/chunk、BIN、bufferView、accessor、mesh graph 和 metadata 的确定性校验。
- 导出逐层 GLB、`model-index.json`、`audit-report.json` 与项目源文件组成的 Release ZIP。
- 原生路径由 `.sapmodel.json` 生成 GLB；外部路径只读导入已校验 GLB，在 Studio 中补充 SPACE，
  以新文件追加导出。两条路径都必须在最终 bytes 上重新解析和校验。
- 外部工作区会在项目树中列出原 GLB 的 semantic mesh nodes，可搜索、按类型筛选并查看 metadata；
  这些节点始终只读，只有 Studio 新增的 SPACE 进入可编辑 Domain。

## GLB 模型数据注入与外部补空间

“GLB模型数据注入”位于当前工作区的 `V0.4 GLB metadata import`，与主编辑器统一管理，
但仍由独立的 8002 服务运行。在 Space Model Studio 项目目录中执行：

```bash
npm run injector
```

该命令会持续占用当前终端；服务显示已启动后再点击顶部“GLB模型数据注入”。如果终端退出，
8002 服务也会停止，需要重新执行此命令。

从 Studio 顶部进入注入页时会携带当前主页面地址；注入页右上角的“返回 Space Model Studio”
可回到原页面及其实际开发端口。

部署时可通过环境变量覆盖入口地址：

```bash
VITE_GLB_INJECTION_URL=https://example.com/glb-injection/
```

外部 GLB 补空间是另一条只读工作流，不把 GLB 逆向恢复为完整参数化项目：

```text
originals/A_1F.glb
  → parse + strict validation（输入必须已含完整 semantic metadata）
  → Studio “导入 GLB 补空间”
  → 只读查看外部模型并新增一个或多个 SPACE
  → 检查 SPACE SID/findId、node/mesh 数量和冲突
  → append-only 写出 outputs/A_1F-space-enriched.glb
  → parse + strict validation + preservation audit
```

原始 GLB 不覆盖、不改名为输出；输出只允许更新必要的 buffer 长度并追加 JSON 数组项和 BIN
数据。原 arrays/nodes 前缀、scene.nodes 前缀和原 BIN 前缀必须保持不变。A_1F golden 输入是
该流程的目标样本：补 SPACE 前为 139 个 semantic nodes，补充后应为 `139 + 新增 SPACE 数量`。

## 默认 Demo

应用启动时加载：

```text
Demo Hospital
└── Building A
    ├── A_1F
    └── A_2F
```

每层有 4 面墙、1 扇门、2 扇窗、楼板、天花、OFFICE Space、HYDRANT Facility、楼梯
和电梯，共 13 个实体。代表性 SID：

```text
WALL_A_1F_01
DOOR_A_1F_E_01
WINDOW_A_1F_N_01
SPACE_A_1F_OFFICE_01
FACILITY_A_1F_HYDRANT_01
STAIR_A_1F_N_01
ELEVATOR_A_1F_E_01
```

## 墙体绘制交互

进入墙体工具后，视口中的基本操作流程如下：

```text
第一次点击：确定当前墙段起点
移动鼠标：显示墙体、中心线、长度、角度和对齐线预览
第二次点击：生成墙体
继续移动：下一段自动以上一段终点作为起点
继续点击：连续生成相连墙段
Esc：取消当前绘制并退出墙体工具
Alt：移动或点击时临时关闭端点与轴向吸附
```

吸附优先考虑已有墙体端点，其次检测当前墙段起点和已有墙体端点的 X/Z 轴向关系。
命中轴向对齐时，视口显示对应方向的虚线辅助线，便于闭合矩形、正方形和规则房间轮廓。
最后一段墙体闭合轮廓后，编辑器会在同一次 Undo/Redo 历史中生成自动 Space、地板和天花。

## 项目与交付文件

`.sapmodel.json` 是唯一可编辑源文件；GLB 是编译产物。默认 Release ZIP 包含：

```text
A_1F.glb
A_2F.glb
model-index.json
audit-report.json
Demo Hospital.sapmodel.json
```

Release 只有在 Domain 校验以及每个最终 GLB 回读校验都达到 0 error、0 warning 后才会
下载。导入文件始终只读，导出会产生新下载，不覆盖原件。

也可用命令行对单个矩形 SPACE 执行同一条 append-only 链路（输出路径必须是新文件）：

```bash
npm exec -- vite-node scripts/enrich-external-glb-space.ts \
  input.glb output-space-enriched.glb 77.8 17.3 4 3 OFFICE
```

## 目录

```text
src/domain/       持久化契约、schema、命令与序列化
src/metadata/     方位、SID、语义优先级和 metadata 校验
src/geometry/     参数化几何 builder 与一实体一 node 几何合并
src/glb/          GLB 编码、解析、逐层导出与回读
src/validation/   Domain/GLB release validator 和 audit
src/export/       ZIP 打包
src/components/   Three.js 编辑视口
tests/            单元、集成和完整 Release 验收
docs/             产品、格式、几何、metadata、验证与迁移规范
```

## 文档

- [项目格式](docs/PROJECT_FORMAT_SPEC.md)
- [GLB Metadata 契约](docs/GLB_METADATA_SPEC.md)
- [GLB Release 验证](docs/VALIDATION_RULES.md)
- [验收测试与证据](docs/ACCEPTANCE_TESTS.md)
- [V0.4 迁移说明](docs/V04_MIGRATION_NOTES.md)
- [几何规则](docs/GEOMETRY_RULES.md)
- [架构](docs/ARCHITECTURE.md)
- [产品范围](docs/PRODUCT_SCOPE.md)

## 已知边界

- 这是 Demo 级语义建筑建模器，不是通用 Mesh/CAD/BIM 编辑器。
- 既有 GLB 的通用 metadata 注入仍由独立 V0.4 工具负责；主编辑器只读导入已校验 GLB 并支持追加 SPACE，
  不尝试把任意 GLB 逆向恢复为参数化建筑构件。
- 初版不提供多人协作、云端存储、数据库、IFC 全量解析或多楼层 assembled GLB。
- 自动房间第一版基于墙体中心线和端点拓扑；不计算墙厚净边界、内洞，也不会因后续删墙自动删除已生成对象。
- 不修改也不依赖 Space AI Platform 的 `src/ssp`；双方只通过 GLB Metadata 契约连接。
- 墙体连续绘制和可视化对齐线为当前开发中的交互优化；切换环境或交接开发前，应执行类型检查和生产构建确认编译状态。
