# 参数化几何规则

`src/geometry` 只负责把 Domain Entity 投影成 Three.js 几何。项目数据始终是唯一事实来源，移动、编辑和宿主关系必须先写回 Domain Model，再重新投影。

## 核心不变量

- 一个语义实体只产生一个 `THREE.Mesh`。墙块和楼梯踏步会先合并为一个 `BufferGeometry`，不会使用子 Mesh 或 Group 表示同一实体。
- 所有长度、宽度、高度、厚度和深度必须大于 0；安装高度、窗台高度和 opening offset 不得为负数。非法参数抛出 `GeometryBuildError`，绝不把负数静默取绝对值或生成负尺寸几何。
- `floor.elevation`、实体 `transform` 和参数化几何分层应用。几何构造器不修改 Domain Entity。
- `buildEntityMesh` 只在 `userData` 中保存稳定的 `entityId`、`kind` 和语义标记，不缓存可能过期的实体副本。

## 坐标系与投影

平台使用右手坐标系、`+Y` 向上：

- Wall 的局部 `X` 从 `start` 指向 `end`，局部 `Y` 为高度，局部 `Z` 为墙厚。墙几何以 `start` 为 Mesh 原点，再绕 Y 轴对齐到终点。
- Door/Window 的几何中心位于宿主墙局部 `offset`，垂直中心为 `baseOffset + sillHeight + height / 2`。宿主墙旋转或平移时，opening 使用同一局部框架。
- Slab/Ceiling/Space 的 polygon 点使用实体 XZ 坐标，垂直范围分别为 `baseOffset..baseOffset + thickness`、`height..height + thickness`、`0..height`。
- Stair 使用 `start/end` 和 `totalRise/stepCount` 作为权威参数；`position.y` 作为楼梯基准高度。每级为正尺寸实体，随后合并。
- Elevator 使用 `center` 定位 XZ，`position.y` 为底部高度。
- Facility 使用 `position.x/z` 与 `mountHeight` 定位；`mountHeight` 是设施底部高度，避免与编辑器保留的 `position.y` 重复叠加。

## 墙体开洞

第一版不使用 CSG。`computeWallSegments` 执行以下步骤：

1. 按 `wall.openings` 精确解析 Door/Window，拒绝缺失引用、反向宿主关系漂移和重复 ID。
2. 将 opening 转换为局部矩形：`left = offset - width / 2`、`right = offset + width / 2`、`bottom = sillHeight`、`top = sillHeight + height`。
3. 校验洞口不得越过墙长/墙高，多个 opening 的水平区间不得重叠。
4. 用所有 opening 左右边界切分局部 X，再从每个 X 带中减去活动洞口的 Y 区间。
5. 只为宽和高均严格为正的剩余矩形创建盒体，并合并为一个无材质分组的 `BufferGeometry`。

洞口恰好贴墙边或墙底是合法的，不会生成零宽/零高盒体。如果洞口移除整个墙体实体，构建会明确失败，避免导出不可见的空墙 Mesh。

## 多边形三角化

Slab、Ceiling 和 Space 共用 `buildPolygonPrismGeometry`：

- 支持顺时针、逆时针和凹多边形；可接受末点重复首点的闭合写法。
- 至少需要 3 个唯一有效点，面积必须大于容差。
- 重复点、自交、非有限坐标或无法三角化的 polygon 会失败。
- 顶面和底面由 `ShapeUtils.triangulateShape` 三角化，边界逐边封口，因此结果是具有法线和包围盒的封闭薄棱柱，而不是 polygon 包围盒。
- 第一版不支持 polygon 内洞；建筑门窗开洞走独立的墙体分段流程。

## 基础实体表示

- Door/Window：单盒体，宽 × 高 × 深。
- Stair：逐级升高的盒体序列，合并为一个 `BufferGeometry`。
- Elevator：矩形轿厢/井道盒体。
- Facility：`box` 和 `icon` 使用可拾取盒体；`cylinder` 使用 20 边圆柱并分别缩放到 width/height/depth。
- Space：透明材质由默认 Mesh 工厂提供，几何本身仍是可计算包围盒的封闭薄棱柱。

## 公共 API

```ts
import { buildEntityMesh, buildEntityMeshes, buildFloorMeshes } from '@/geometry'

const oneMesh = buildEntityMesh(entity, {
  entities: floor.entities,
  floorElevation: floor.elevation,
})

const floorMeshes = buildFloorMeshes(floor)
```

`geometryRegistry` 覆盖 `wall/slab/ceiling/door/window/space/facility/stair/elevator` 九种 kind。墙、门和窗构建时必须提供同层 `entities`，用于核对宿主关系。调用者从场景移除投影后应释放 geometry；使用默认材质时也应释放对应 material。
