# 千星look3

千星look3 保留 Look2 的界面布局与编辑扩展，整合固定版本 Look 的 Lua 模拟器和 ugc-tool 的 UI 动画编辑器。当前版本 **3.2.0**。

真实千星导入、用户宿主和设备验收单独记录：本地检查通过不代表这些外部验收完成。

架构与使用入口见[文档导航](docs/README.md)。作者预览使用图片透明轮廓遮罩，播放和 PNG 使用矩形几何遮罩，两者按用户选择保留，详见[渲染边界](docs/渲染边界.md)。

## 启动与工作区

Windows 运行 `powershell -File look3-launch.ps1`。启动器优先使用 4260—4279 的空闲端口，核对构建身份和工作区后复用匹配服务；默认存档目录为 `look3-workspace/`。当前工程只有显式保存后才写入存档。

从源码安装依赖使用 `pnpm install --frozen-lockfile`，构建使用 `pnpm build`，完整回归使用 `pnpm test`。构建和测试不等于千星游戏验收。

## 编辑与导出

沿用控件树、画布、属性、动画列表和时间轴；Lua、服务端逻辑和调试通过现有面板进入。完整 JSON 存档保存布局、脚本、动画和挂载；GIA、Lua、站点 JSON、Timeline/Primitive 数据用于相应外部链路。

导入千星奇域时，选择导出的 GIA，核对实际客户端控件及模板索引和脚本挂载；动画按导出的 Lua 数据/运行库使用。模拟器的显示、音频和信号结果需要分别在千星验证，不能由本地回归替代。

## 上游更新

`pnpm upstream:status` 查看逐项状态；`pnpm upstream:check` 检查两个上游并输出差异，不修改业务源码。离线检查用 `node scripts/upstream-sync.mjs check --offline`。适配后的补丁通过 `node scripts/upstream-sync.mjs apply --patch <项目内补丁路径>` 应用；补丁失败会保留当前源码，来源与验收状态不会自动前移。完整流程见[更新说明](docs/上游/更新说明.md)。

## 接入和分发

Web、MCP 和 DSH 使用同一 Studio/Runtime。产品包名分别为 `look3-web`、`look3-mcp`、`look3-dsh-plugin`，MCP 工具前缀为 `look3_`。MCP 与 Web 组合时，工作区必须相同；Web 默认地址为 `http://127.0.0.1:4260`，也可用 `--web-url` 指定。MCP 默认为显式步进时钟，Web/DSH 使用实时钟。

`pnpm pack:release` 生成本地三产品包，`pnpm test:packages` 在独立消费目录核对安装。生成包不会自动发布到 npm，也不会升级现有用户服务。DSH 配置、宿主及 Docker 实际运行的验证范围另行记录。

内部 `look2` 状态字段、CSS 类名和旧格式标记继续保留以兼容现有工程。

## 后续工具

第二期优先图片拟合、矩形压缩和 UI 通用图元算法；第三期考虑 Graph Code/GIL 工具与 genshin-ts。具体接入建议见[本地工具评估](docs/上游/本地工具评估.md)。本期没有把这些工具的源码复制进运行核心。

## 来源与许可

本项目派生自两个上游仓库，来源、固定提交与许可边界见[来源与许可记录](docs/上游/来源与许可.md)。

- Look（`1475505/miliastra-beyond-simulator`）：GPL-3.0-only，本项目沿用其 [LICENSE](LICENSE)。
- ugc-tool（`xiaomoL444/ugc-tool`）：该仓库顶层未提供 LICENSE，README 仅含安装说明与致谢，**不能据此认定其开源许可**。本项目对其中 UI 动画编辑器部分的适配属本地任务，不对外代表其授权条款。
- 不捆绑上游引用的字体文件；本地授权字体通过 `QXQY_FONT_PATH` 配置。
