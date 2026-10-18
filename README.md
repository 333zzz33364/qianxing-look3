# look2.0

## 【未读】当前交付与验证边界（2026-10-16 核对）

【未读】当前源码及发布包为 **2.0.25**，第30轮参考UI改版本机阶段已完成，独立结论为限定通过；整体`projectComplete=false`。当前状态和授权以[项目工作记忆](工作记忆.md)为准，实际范围见[第30轮交付报告](look2-workspace/acceptance-20261014/ui-30/delivery-summary.md)和[检查点](look2-workspace/acceptance-20261014/ui-30/resume-checkpoint.30.json)。

【未读】已记录的第30轮证据为434/434完整回归、三构建、三包44文件核对及tools0.2.0-rc.2安装smoke；五尺寸布局与10项页面操作限定通过。本轮只重新核对文件身份和整理文档，没有重跑这些产品检查；旧tools0.1、官方双CLI及更早格式证据保留原版本，不提升为2.0.25验证。

【未读】千星实机与原作者旧站工程暂缓以后补验；真实DSH会话、Desktop插件和Docker验收已由用户取消。未新增游戏试玩，浏览器关闭状态保留原记录的未确认身份；本轮没有探测或启动服务。

## 项目说明

【未读】look2.0 是独立于原 Look 的本地客户端 UI 动画编辑器，参照 [ClientUIAnimationEditor](https://tool.xiaomol444.xyz/ClientUIAnimationEditor) 的布局、素材和数据格式，保留 Look 的 Lua Runtime、GIA、Web、DSH 与 MCP 接入。功能边界见[功能对照清单](docs/reference-parity.md)，架构和恢复入口见[项目工作记忆](工作记忆.md)。原 Look 与正式用户存档保持隔离。

【未读】本文其余带旧版本号或日期的验收说明用于记录各自阶段；其中结果只适用于对应的历史源码和环境，不表示当前恢复后的新版验证已经完成。

【未读】2.0.17在队列最新动画数据上拒绝短于现有关键帧或事件的时长，失败时保持播放头和历史。2.0.16的多选关键帧统一限幅、吸附与撞帧保护、当前播放头新增事件、事件顺序与最近50条日志、动画管理成功后重置选择等修复保留。对应时间轴回归32/32、全量363/363通过，Web、DSH、MCP均已构建。2.0.15及此前变换、颜色和单次撤销修复保留。独立页面与安装结果以项目记忆和验收清单为准，完整37项尚未全部验收，外部实机与真实复杂文件样本分别记录。版本、文件名和校验值以 `release/manifest.json` 为准，本地候选包不代表公开发布。

【未读】以下启动、构建、安装及试玩按对应任务授权执行，本轮整理未运行这些命令。

Windows 双击上级目录的 `look2.0.cmd`。默认打开 `http://127.0.0.1:4174/editor`，存档在 `look2-workspace/`。原 Look 使用独立的 4173 端口和工作区，迁入旧工程时另存新路径。

从源码启动需要 Node.js 22+ 与 pnpm 10.15.0：

```powershell
corepack pnpm install --frozen-lockfile
node scripts/build.mjs web
node web/dist/server.js --workspace ./look2-workspace --port 4174
```

## 编辑与保存

首页在同一个工作区提供控件树、画布、完整属性和脚本挂载、Animator 和时间轴。资产切换选择服务端界面或客户端模板，底部切换动画、Lua、逻辑与调试面板；工具栏提供新建、导入、保存、操作记录、图片与模板管理。

1. 新建控件或导入站点 JSON v12、完整 Look 存档、GIA、Lua Timeline Data、PSD 或 Spine 3.8。
2. 在画布和属性面板调整控件，按设备检查四平台布局；添加关键帧和事件后播放编辑预览。
3. 点击“保存”写入正式工作区文件。浏览器 IndexedDB 草稿自动保留；草稿恢复不替代手动保存。
4. 导出完整存档继续编辑，导出站点 JSON 与参考站互通，导出 GIA 用于千星导入。

控件、素材、模板、动画共用撤销/重做与操作记录。数值与关键帧时间、属性值、入侧值和透明度在失焦后提交；提交失败时保留草稿，可重试或按 Escape 取消。Web 的多标签页写入有版本检查；磁盘文件被其他客户端更新时，重新加载后再保存。

## 图片与图元

内置素材直接在线访问参考站当前图片源，支持分类、搜索、真实缩略图和边框。宿主自动缓存已加载素材；断网时可读取已有缓存。Web 缓存默认在工作区 `.look2-image-cache/`，DSH 在其用户目录 `look2-image-cache/`；可用 `LOOK2_ASSET_CACHE` 指定位置。

本地图片和通过“图片网址”导入的图片都嵌入工程。网址图片最大 32 MB，后续重开不依赖原网址。图片资源可共享给多个控件，统一重命名、清除绑定和删除。

图元拟合在本机 Worker 计算，支持椭圆、矩形和三角形，数量、精度、线程与透明背景可调整。可批量生成缺失图元、取消计算，并切换原图/拟合显示。支持纯填充 SVG 与 shaper CSS 导入导出；无法表达的曲线、描边、渐变或蒙版会明确报错并保留原结果。

正式工程保存原图和拟合数据；GIA 导出及 Runtime 编译时才将图元转换为实际图片子控件。在线素材与编辑预览需要浏览器图片能力，Headless 截图的原生图片代理仍有范围限制。

## 动画与 Lua 互通

支持 31 种缓动、补间/阶跃、跳变入侧值、前帧增量、RGBA、旋转多圈和 0–255 组合透明度。旧 Look 的初始值增量通过迁移保留效果。事件只在播放跨过事件时触发，拖动播放头不触发；同刻按列表顺序执行。

| 导出 | 用途 |
| --- | --- |
| 完整存档 / 站点 JSON v12 | 继续编辑或与参考站交换工程 |
| Timeline Data / TweenTimelineLib | 动画数据与 `Create(root, data, options)` 可控制序列 |
| PrimitiveData / PrimitiveImageLib | 图元数据与 `create(root, data, imagePrefabIndex)` 生成库 |
| SVG / shaper CSS | 交换当前图片资源的拟合结果 |
| 播放脚本 / GIA | 独立 Lua 或含源码映射、挂载的客户端模板 |

PrimitiveImageLib 需要先在千星中建立图片控件模板，并传入该模板索引；模板索引与图片 ID 是不同字段。部分真实 API 不允许运行时设置 imageType，库会返回告警；模板应预设所需模式，或使用已烘焙的 GIA。尚无千星实机验收结论。

有动画的客户端根可生成包含全部动画的播放脚本，每个实例有独立播放器，同时播放一个动画。`Look2Play()` 重播当前动画；`Look2PlayByName(name)` 或 `Look2PlayById(id)` 切换，`Look2Stop()` 恢复受控属性基础值；保留 `Look2Pause`、`Look2Resume`、`Look2Seek`。名称重复时按名调用报错，使用ID调用。脚本通过根控件的 `GetScriptByPath(脚本短名):Invoke(...)` 控制播放器；短名去掉导出路径的目录和 `.lua` 后缀。事件属性可选择处理脚本和函数，也可调用 `Look2BindEvent(name,targetPath,functionName,scriptPath)` 显式绑定处理器，绑定接口兼容完整映射路径。生成脚本只用于导出/编译，存档中的用户脚本和可编辑轨道保持独立。

“试玩”在原画布启动复制出的工程，可选择当前模板或完整界面，以及玩家数量；默认从起点自动播放当前动画。试玩期间查看运行属性、日志、变量和信号，支持暂停、继续、单步、重启、停止和玩家切换；停止后恢复编辑视角、选择和时间轴位置。运行变化不写回工程。保存、导出和试玩会先提交当前输入并等待编辑队列，提交失败可修正并重试，或按 Escape 取消该字段草稿后继续。

PSD 在 Worker 中解析分组、像素蒙版和图层并编码图片，最大 128 MB，支持取消及超时；不支持的位深与色彩模式会明确报错。Spine 3.8 支持 region 贴图、骨骼层级和常见动画轨道；mesh 和失效贴图会拒绝，剪切、约束、跨骨骼插槽顺序等无法完整表达的部分会显示具体告警。复杂真实文件仍须核对导入结果。

## 导入千星

导入 GIA 中的客户端模板及 Lua 脚本映射，将目标根模板实例化到客户端界面，核对生成播放脚本挂在对应根控件并启用。单独导入 Lua 时需自行建立脚本映射及挂载。导出文件附带的 warnings 应在导入前检查；自动化 Runtime 与 GIA 回读不替代千星实机验证。

当前示例为 `look2-workspace/功能对齐示例.7`，含完整存档、站点 JSON、GIA、播放脚本、Timeline Data/Lib、PrimitiveData/Lib、SVG 和 CSS，共十份文件。先导入 `.7.save.json` 继续编辑，千星使用 `.7.gia` 并核对脚本挂载。`node scripts/create-parity-example.mjs` 生成下一版本；已有文件不会覆盖。独立回读及站点 JSON 再导入后 Lua/GIA 的图片颜色动画证据见本轮项目记忆。

当前融合联动示例为 `look2-workspace/融合联动示例.9`，包含完整存档、站点JSON、GIA、播放器、控制脚本、双实例宿主脚本和导入说明。播放器路径由模板根GUID固定，新增脚本不会改变调用路径。`node scripts/create-fusion-example.mjs` 生成下一版本，已存在的文件不会覆盖；`node scripts/check-fusion-example.mjs 融合联动示例.9` 验证当前示例。千星中需要另外建立示例说明中的服务端信号节点图，Look 的模拟规则无法随站点JSON或GIA携带。独立 Runtime 验收的实际结果见本轮项目记忆。

## 宿主与分发

三个产品均从此目录构建，当前 look2.0 尚未公开发布到 npm 或独立远程仓库；请使用本地源码或本地安装包。

- [Web 启动、缓存与部署](web/README.md)
- [DSH 插件安装与工具](dsh-plugin/README.md)
- [MCP stdio 接入](mcp/README.md)
- [分发设计与验证](DISTRIBUTION.md)
- [Studio 核心](studio/README.md)、[Lua Runtime](client/lua-runtime/README.md)、[服务端模拟](server/README.md)

```powershell
node scripts/build.mjs
corepack pnpm test
corepack pnpm pack:release
corepack pnpm test:packages
```

【未读】当前安装包仅保留`look2-dsh-plugin-2.0.25.tgz`、`look2-mcp-2.0.25.tgz`和`look2-web-2.0.25.tgz`，文件名及校验值以[发布清单](release/manifest.json)和[SHA256SUMS](release/SHA256SUMS)为准。适用许可证为 [GPL-3.0-only](LICENSE)。

【未读】2026-10-16已删除release中24个旧包；[清理清单](archive/2026-10-16-旧发布包清理.json)保留删除身份，归档中的30个旧包仍作冻结取证。示例的旧save用于占用已用编号，融合示例.6也是默认检查输入，因此保留；不能仅按版本数字清理。

## 2026-10-09 第8版历史验证脚本入口（第10版已运行成功专项及全量）

【未读】本节的 2.0.17/第8版/第10版说明属于历史记录；旧包和哈希保留原版本范围。当前候选以 `release/manifest.json` 为准，最新本机检查及未验边界见[本轮交付记录](look2-workspace/acceptance-20261014/ui-30/delivery-summary.md)。

在 Windows PowerShell 中，进入本项目根目录，可执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-pending.ps1
```

【未读】该脚本逐项执行语法、领域专项、只读证据审计和完整回归，通过后按选项构建；失败时停止并保留独立日志。当前日志目录命名为 `verification-15-<时间戳>-<唯一标识>`，不会自动发布、覆盖旧包或启动游戏试玩。页面和安装验收另行记录。最新结果见[本轮交付记录](look2-workspace/acceptance-20261014/ui-30/delivery-summary.md)，旧第8版及[第9版检查点](look2-workspace/acceptance-20261009/development-progress.9.md)保留为历史入口。


## 【未读】旧候选历史说明

【未读】以下两段从本文件原“当前恢复状态”移入，正文和原阅读状态保留；其中“当前”“最新”和待验项只对应原记录时点，不替代顶部现行状态。

【未读】【2026-10-11 当前候选】版本为 **2.0.20**。DSH 工具 peer 保留 0.1 兼容范围并增加 0.2；开发环境按官方 0.2 peer 固定版本，锁文件同步更新。完整回归 **408/408**、Web/DSH/MCP 三构建通过；6 项待补原生范围及 UI07 已获独立复核。最新安装、CLI 双版本结果、包哈希与分层边界统一见[本轮交付记录](look2-workspace/acceptance-20261011/resume-21/delivery-summary.md)和[当前验收台账](look2-workspace/acceptance-20261009/acceptance-ledger.11.json)。DSH Desktop、千星实机和真实复杂样本仍待验；未进行游戏试玩或公开发布，Docker 容器构建仍未验证。

【未读】【历史验证，第16版之前】依赖误安装污染发生前，Windows 环境曾完成全量 **400/400**、15/15 执行步骤，以及 Web、DSH、MCP 三构建。这是当时源码和依赖状态的历史结果，不代表依赖恢复后的 2.0.19 验证完成。原始汇总见[第16版之前的本机验证记录](look2-workspace/acceptance-20261009/verification-15-20261010-100816-fc7154cc/run-summary.json)，当前恢复入口和剩余验收见[项目工作记忆](工作记忆.md)。
