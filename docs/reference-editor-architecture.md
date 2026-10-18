# 参考编辑器与 look2.0 的架构融合方案

【未读】【2026-10-14 视觉目标更新】用户明确要求“修改look2项目的ui，尽量跟参考网站一致，look项目的功能放在空位”。2.0.25 已按提供的参考源码与截图还原标题区、工具栏、控件树、画布上下工具条、Animations、Inspector 和时间轴样式。Look 的资产切换/试玩位于标题区右侧，Lua/逻辑/调试位于底部工具栏右侧，脚本挂载位于属性页签旁。当前视觉目标同时包含布局和样式，覆盖下方历史方案“只移植行为语义”的限制；继续保留 React 注入、共享 Studio 和现有宿主/存档契约。实现和验证见[第30轮报告](../look2-workspace/acceptance-20261014/ui-30/delivery-summary.md)。

状态：本文保留原架构建议。2026-10-03 已按后续获批融合计划实施共享工作区、面板适配、原画布试玩和播放器扩展，当前实施/验收见 [fusion-acceptance.md](fusion-acceptance.md)；不表示本文每项建议均已实施。

参考源码快照来自 [xiaomoL444/ugc-tool](https://github.com/xiaomoL444/ugc-tool)，固定提交 [`d0dfb32`](https://github.com/xiaomoL444/ugc-tool/commit/d0dfb32ba0d65319adee2dd53e3f433bb8fdea00)。本地源码摘录说明见 [`ugc-tool-client-ui-editor.1/README.md`](../../ugc-tool-client-ui-editor.1/README.md)。

## 结论

以 look2 现有的 Studio 数据与多宿主接口为骨架，借鉴参考源码按功能拆分纯逻辑模块的做法，逐步拆解 look2 的编辑界面。不要整体移植参考项目的 Vue 页面：两边的前端框架、存储服务和宿主依赖不同；应移植经过核对的行为语义，并在 look2 自身的数据模型与接口中实现。

## 当前结构对比

| 方面 | 参考编辑器 | look2 |
| --- | --- | --- |
| UI 入口 | Vue 的 `ClientUIAnimationEditor.vue` 集中编排主要面板与操作，约 4,895 行。 | `editor-ui/look2.js` 通过注入 React 创建编辑视图，当前约 1,420 行；资源与拟合等界面另有模块。 |
| 功能逻辑 | 若干 TypeScript 辅助模块承担控件注册、关键帧、缓动、导入导出等纯逻辑，例如 [`controlRegistry.ts`](https://github.com/xiaomoL444/ugc-tool/blob/d0dfb32ba0d65319adee2dd53e3f433bb8fdea00/src/views/ClientUIAnimationEditor/controlRegistry.ts) 和 [`keyframeTimeline.ts`](https://github.com/xiaomoL444/ugc-tool/blob/d0dfb32ba0d65319adee2dd53e3f433bb8fdea00/src/views/ClientUIAnimationEditor/keyframeTimeline.ts)。 | `studio/ui/`、`studio/look2/` 已保存布局、控件、动画、历史和互通逻辑，但部分面板编排与交互仍集中在 `editor-ui/look2.js`。 |
| 状态与宿主 | 页面直接使用 Vue Router、项目存储类型、提示组件、OSS 服务及项目内 GIA 转换包。 | `createEditor(React, { api, playUrl, saveToWorkspace })` 由宿主注入；编辑状态、revision、patch 和事务历史由共享 Studio/Controller 管理，供 Web、DSH 与 MCP 流程复用。 |
| 主要优势 | 功能语义细分较清楚，Timeline 与属性规则有可独立检查的模块。 | 宿主隔离和统一数据边界更适合保留 Web、DSH、MCP 与 Runtime 的一致行为。 |

参考页面文件：[ClientUIAnimationEditor.vue](https://github.com/xiaomoL444/ugc-tool/blob/d0dfb32ba0d65319adee2dd53e3f433bb8fdea00/src/views/ClientUIAnimationEditor/ClientUIAnimationEditor.vue)。参考代码只作为字段语义、边界行为和交互的依据，不作为可直接替换的 UI 实现。

## 推荐目标结构

1. **`editor-ui/` 负责呈现与交互。** 按工具栏、控件树、画布、属性面板、动画列表、时间轴和对话框逐步拆分视图；保留现有 React 注入方式。UI 通过宿主提供的 API 读写状态，不直接操作文件系统、OSS 或 Controller 内部数据。
2. **`studio/` 负责唯一的编辑数据与领域规则。** 延续 `studio/ui/` 中的控件、布局和变换职责；在 `studio/look2/` 中集中动画/关键帧、事件、缓动、存档迁移和时间轴互通规则。计算型函数尽量保持纯函数，便于单元测试和跨宿主复用。
3. **格式和宿主适配留在边界。** GIA、站点 JSON、Timeline Data、PrimitiveData 等由现有互通模块负责解析与导出；Web/DSH/MCP 继续调用同一 Studio 契约，不在各宿主复制动画规则。
4. **分步迁移，不改变公开契约。** 先提取可测试的领域逻辑，再拆 UI 面板；每一步保持 `createEditor` 参数、`api(sessionId, action, body)`、存档 schema 和已有导出格式兼容。参考源码中的 TypeScript/Vue 实现按现有 JavaScript 模块风格移植语义，不引入框架迁移。

### 数据流

```text
editor-ui 面板
  → 宿主 API（session、action、body）
  → Studio / Controller（revision 校验、事务、patch、历史）
  → 规范化项目快照
  → Web、DSH、MCP 编辑器界面与各自存储适配
```

避免在 UI 和 Studio 同时维护可编辑的权威副本；每次用户操作仍由现有事务边界提交，并通过快照更新界面。

## 后续实施顺序

1. 对照 `editor-ui/look2.js`、`editor-ui/look2-assets.js`、`editor-ui/look2-resources.js` 与 `studio/ui/`、`studio/look2/`，标明界面状态、领域规则、宿主操作的现有归属及重复逻辑。
2. 先把仍留在界面层的关键帧操作、事件排序、缓动和时间计算整理为 Studio 纯逻辑模块；用现有与参考源码语义对应的固定样例锁定行为。
3. 再逐个拆分时间轴、属性检查器和画布等界面区域，保持 UI 事件通过同一 API 和事务提交。
4. 每批变更运行相关单元与互通回归，再验收 Web、DSH、MCP 的构建、保存/重载和导入导出；按 `reference-parity.md` 更新实际证据，不将构建成功当作浏览器交互验收。

## 验收标准

- 旧存档迁移、revision 冲突、失败回滚、撤销/重做及现有 JSON/GIA/Lua/图元格式保持兼容。
- 同一组关键帧、阶跃/缓动、前帧增量、事件同刻顺序和格式互通样例，在拆分前后得到相同结果。
- Web、DSH、MCP 使用同一领域逻辑；界面拆分不产生第二套编辑状态或仅对单一宿主生效的动画规则。
- 现有自动化、三产品构建与包检查通过；对照表中的页面交互另按实际操作验收。千星实机结果独立记录，不由模拟器或单元测试代替。

## 约束与风险

- 参考源码本身也有大型 Vue 页面，适合借鉴其部分纯逻辑模块，不应把它视为所有 UI 代码都已模块化的范例。
- look2 已支持多宿主和多个存档/互通格式；大规模重写 UI 或改变 schema 会扩大回归范围，因此以小步提取、保持数据流和格式不变为默认策略。
- 本方案只描述 look2 架构融合方向；不修改原 Look、不改变 4174 端口和独立工作区，也不代表后续重构已经开始。
