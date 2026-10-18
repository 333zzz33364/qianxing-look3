# look2.0 2.0.4 代码验收记录

【未读】本页是2.0.4阶段历史回读结果。功能对齐示例.1/.2的旧导出文件现位于[归档示例目录](../archive/2026-10-10/obsolete/look2-workspace)，原.save.json仍在look2-workspace/保留；下文“现行”仅指当时，不代表当前交付。最新状态见[项目工作记忆](../工作记忆.md)。

本次按既有验收范围静态回读现行 `look2-workspace/功能对齐示例.2` 十份产物；`.1` 保留原样。未扩展到其他功能，也未试玩玩法、使用浏览器或验千星实机。测试结论是本地代码与版本化样本证据，不等同于真实网页、真实 DSH CLI 或游戏内证据。

2026-10-02 增补：Timeline Data 无效 root 与斜杠路径硬化的定向自动化结果已记入 LU01；此增补没有重跑本文其他项目或整份清单。

| 项目 | 结论 | 代码与测试证据 |
|---|---|---|
| AN04 | **模拟器逻辑通过** | [`sampling.js`](../studio/look2/sampling.js) 实现 31 种 EaseType 和旧别名；[`look2-player.test.mjs`](../studio/test/look2-player.test.mjs) 逐点对照 JS/Lua easing、相对值和跳变，并覆盖颜色、显隐、结束保持及脚本挂载。浏览器操作与真机表现未验。 |
| AN05 | **模拟器逻辑通过** | [`sampleTrack`](../studio/look2/sampling.js) 按上一关键帧的解析右值处理 `relative`，入侧 `leftValue` 使用同一基准；[`look2-animation-interop.test.mjs`](../studio/test/look2-animation-interop.test.mjs) 将 anchoredPosition X/Y、sizeDelta X/Y、localScale X/Y 六字段逐一对照 JS 与 Lua Runtime，并检查初始基线和半程值。 |
| AN06 | **模拟器逻辑通过** | 同一 Interop 测试验证 350°→730° 在半程保持 540°，且 JS/Lua Runtime 一致；现有测试覆盖 0–255 组透明度、颜色 RGBA、首帧前显隐。 |
| TP01 | **模拟器逻辑通过** | [`look2-history.test.mjs`](../studio/test/look2-history.test.mjs) 验证 GIA 模板注册与索引、带脚本模板保存/重开、实例化及缺失引用警告动态出现在 `snap.look2Warnings`，导入模板后警告消失，移除模板后恢复；连续实例化产生兄弟唯一名称。 |
| IM01 | **站点 JSON 数据往返通过；自定义画布预览有限** | [`site-json.js`](../studio/look2/site-json.js) 对站点 JSON v12 做语义映射，保留原始节点属性与未知顶层元数据；非预设 `deviceMode`、`previewPresetId`、画布宽高作为内部来源状态随工程保存，导出时原样回写。显式选择预设后更新这些字段，支持撤销/重做；[`look2.test.mjs`](../studio/test/look2.test.mjs) 覆盖导入导出、存档重开及 patch/transaction 历史，5/5通过。当前编辑预览仍回落到预设 `pc-16-9`，未实现任意自定义画布尺寸的实时布局。 |
| IM02 | **示例与模拟器测试通过** | `功能对齐示例.2.gia` 回导后有四个拟合图片子项及原五角星；拟合子项的 imageId、RGBA、尺寸、位置、旋转和四平台变换与当前重新导出的 GIA 树一致，顺序为前景三角、椭圆、红矩形、底色矩形。脚本映射挂在模板根，GUID 为 `1073741862`，映射源码与 `.lua` 完全相同。当前导出 GIA 与样本 GIA 字节有差异，但完整 10 节点语义树相同；[`look2-primitives.test.mjs`](../studio/test/look2-primitives.test.mjs) 和 [`look2-integration.test.mjs`](../studio/test/look2-integration.test.mjs) 另验证烘焙层序、四平台适配、播放及源工程不被修改。 |
| IM03 | **指定自动化范围通过** | [`look2-psd-worker.js`](../editor-ui/look2-psd-worker.js) 在 `readPsd` 前用 OffscreenCanvas 工厂调用 ag-psd `initializeCanvas`。[`look2-assets.test.mjs`](../studio/test/look2-assets.test.mjs) 在 Worker VM 中用真实 ag-psd `writePsd` 生成非空 8-bit PSD，再调用真实 `readPsd`，核对 RGBA 像素与输出一致；VM 的 OffscreenCanvas 是测试 shim，不是浏览器原生 Worker。分组、偏移、opacity、mask、隐藏层、超时和失败不提交部分结果另有测试。 |
| IM04 | **部分通过** | [`importSpine`](../editor-ui/look2-assets.js) 明确限定 Spine 3.8 JSON、region 附件与支持的骨骼/插槽轨道；可采样 Bezier、事件和贴图。[`look2-assets.test.mjs`](../studio/test/look2-assets.test.mjs) 覆盖合成骨骼/插槽、30Hz Bezier、缺图和 mesh 拒绝。未用真实 Spine 工程文件核对全部网页边界；多皮肤、约束、deform、draw-order 等仍属警告/不支持范围。 |
| LU01 | **核心导入导出与路径防误选通过；网页边界仍未全验** | [`timeline-lua.js`](../studio/look2/timeline-lua.js) 解析常量 Lua 表并支持版本 3–8；Interop 测试验证 v3–v7 逐版追加且 RGBA 颜色再导出不变，v8 的 root/path、相对帧、事件及扩展字段往返。新增测试确认显式无效root报错、被引用的斜杠名路径导入/导出拒绝、未引用斜杠名不阻断导出；`node --test studio/test/look2-animation-interop.test.mjs` 11/11通过。样本 `.timeline.lua` 含颜色、透明度、旋转和事件并与当前导出逐字节相同；尚无真实网页旧版本文件覆盖所有step/跳变组合。 |
| LU02 | **当前生成库及 .2 示例通过** | 新生成的 `TweenTimelineLib.Create` 验证 schema/version，Runtime 测试确认 3–8 可用、999 和 schema/version 不匹配会拒绝且不改数据；序列、显隐、颜色、事件和重复创建另有运行时测试。`功能对齐示例.2.TweenTimelineLib.lua` 为 13,766 字节，与当前导出逐字节一致。`.1` 中 12,326 字节的旧库仍保留，且不含 `validateTimelineVersion`。 |
| ST01 | **模拟器事务通过** | [`look2-history.test.mjs`](../studio/test/look2-history.test.mjs) 覆盖版本冲突无副作用、失败回滚、一次事务单个历史步、完整 undo/redo、控件与动画引用清理、模板操作历史。 |
| ST03 | **部分通过** | [`platform-layout.test.mjs`](../studio/test/platform-layout.test.mjs) 覆盖当前存档版本 1–4 布局迁移且输入不变；Interop 覆盖旧 `isDelta` 与 0–1 `groupAlpha` 的一次迁移。主代理实际只读导入 `动画联动示例.1.save.json` 与 `原Look 战棋.6.save.json`，逐项比较两棵树的 ID/GUID/名称/kind/active/visible、四平台变换及脚本源码/数量，且源文件 bytes/hash 未变。该比较不等于旧动画效果完整保真；尚无真实旧工程所有轨道的播放采样对照，也未核验整个原 Look 目录差异。 |
| HT01 | **代理验证通过；真实宿主仍未全验** | 主代理报告三产品构建、260/260 全量测试、三个 2.0.4 pack 和 `smoke-packages` 均通过。UI 测试代理执行 Web editor 2/2、DSH plugin 20/20、MCP protocol 3/3；后者覆盖真实 stdio set/export/rollback。本代理没有重跑这些检查。真实 DSH CLI 安装/配置注册与千星实机仍未验证。 |

## 示例产物静态回读

现行集合为 `功能对齐示例.2`，十份文件均存在；`.1` 文件保留未改。`.site.json`、`.lua`、`.timeline.lua`、`.TweenTimelineLib.lua`、`.primitive.lua`、`.PrimitiveImageLib.lua`、`.svg`、`.css` 八份与当前 `createStudio(...).exportData(...)` 输出逐字节相同。`.gia` 字节不同，但与当前重导的完整 10 节点语义树、图元变换和脚本挂载一致。`.save.json`（98,101 字节）作为导入输入未被写入；重新序列化为 98,089 字节时，Studio 将五个 `null` 默认字段归一化为 `""` 或 `1`，除此之外节点/资产内容未发现差异。

`.primitive.lua` 使用参考紧凑 v3 结构，单组 `path` 指向拟合控件，包含矩形、椭圆、三角及底色矩形共 4 行；坐标和尺寸按 240×160 FitData 到 360×240 控件等比放大 1.5 倍。SVG 与 shaper CSS 导入结果均与存档中的原始 240×160 FitData 完全相同，保留元素顺序、颜色、透明度和旋转。`.gia` 中拟合图元分别为 360×240 底矩形、150×195 红矩形、150×150 椭圆和 97.5×90 三角；四个形状都有四平台变换，三角保留 20° 旋转，椭圆透明度为 230/255。播放脚本源码与 `.lua` 一致并映射到 `功能演示容器` 根。

图元 v3 的路径、4 行拟合元素及 1.5 倍等比缩放和 SVG/CSS 原 FitData 回读均按 `.2` 核对。其 `.TweenTimelineLib.lua` 已包含当前 Timeline Data 版本拒绝逻辑；`.1` 的旧库差异仅作为保留旧版本的记录。

## 当前剩余缺口

- 对站点 JSON 自定义 canvas/device 字段、复杂 Spine 实际工程、Timeline 旧网页样本和 2.0.3/原 Look 动画效果分别补端到端夹具。
- 以真实浏览器 Worker/OffscreenCanvas 与 Web/DSH 路由证据补足宿主验证，并核对真实 DSH CLI 安装/配置注册；不把 Node VM 或构建成功当成宿主实测。MCP stdio set/export/rollback 已由代理测试通过。

## 命令与统计

Node 为 v24.21.0。此前代码定向回归 **56/56 通过**（三条命令）；本次未改源码、仅只读比较资产，没有重跑测试：

```text
node --test studio/test/look2-assets.test.mjs studio/test/look2-animation-interop.test.mjs studio/test/look2-history.test.mjs  # 31/31
node --test studio/test/look2.test.mjs studio/test/look2-primitives.test.mjs studio/test/look2-integration.test.mjs        # 14/14
node --test studio/test/look2-player.test.mjs                                                                              # 11/11
```

只读回读命令通过 Node `createStudio`/`importGia`/SVG/CSS 导入器比较十份样本产物；没有写入样本文件。三产品构建结果来自主代理报告，最新全量 `corepack pnpm test` 与真实 DSH CLI 安装本次未执行。

## 主代理阶段收口补充（非本代理重跑）

主代理报告最新 `corepack pnpm test` **260/260 通过**（Runtime 37、Server 11、Studio 176、DSH 26、MCP 3、Web 7），Web/DSH/MCP 三产品构建、三个 2.0.4 pack 和 `smoke-packages` 三产品检查均通过。UI 测试代理另执行 Web editor **2/2**、DSH plugin **20/20**、MCP protocol **3/3**；MCP protocol 覆盖真实 stdio 的 set/export/rollback。以上结果由其他代理执行，本代理没有重跑。

因此 HT01 的 Web/DSH/MCP 集成测试状态更新为**代理验证通过**；仍未验证真实 DSH CLI 安装/配置注册和千星实机表现。
