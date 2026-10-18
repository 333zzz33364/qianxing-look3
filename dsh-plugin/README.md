# look2.0 DSH 插件

包名 `look2-dsh-plugin`，工具以 `look2_` 开头，页面路由 `/look2-simulator/`，按 DSH sessionId 隔离编辑状态。主界面为动画编辑器，可切换到 Look 全功能编辑。

在本项目根构建并生成本地包：

```powershell
node scripts/build.mjs dsh-plugin
corepack pnpm pack:release
```

【未读】安装时使用[当前发布清单](../release/manifest.json)中 dsh-plugin 对应 tarball 的绝对路径，不固定旧版本包名：

```powershell
dsh plugin --profile web add <manifest中当前插件包的绝对路径>
dsh --profile web --dump-config
dsh web
```

当前 look2.0 未发布 npm 或独立 GitHub 仓库。更新后重启 Harness；用户既有 Agent 预设不会被自动覆盖。新版预设服务通过 bundle 注册，旧宿主以目录复制兼容。

共用 Studio 工具包含编辑事务、撤销历史、模板管理和动画导出。`look2_animation_export` 支持 site-json、timeline-data、timeline-lib、animation-lua、primitive-data、primitive-lib、primitive-svg、primitive-css、gia、save。索引为控件模板索引，与图片 ID 分开管理。

插件提供同源图元拟合与 PSD Worker，以及在线图片目录、PNG 和边框路由。缓存默认在 `$DSH_HOME/look2-image-cache`（未设置 DSH_HOME 时为用户 `.dsh` 目录），可通过 `LOOK2_ASSET_CACHE` 指定可写路径。首次读取参考源需要网络，已加载项离线读取缓存；网址图片导入后嵌入工程。

插件 Skill 名 `look2-simulator`，源文件 [skill/SKILL.md](../skill/SKILL.md)；游戏制作预设 ID 为 `look2-wonderland-lua-builder`。源码安装与预构建验证见 [分发设计](../DISTRIBUTION.md)，功能与千星导入见 [项目 README](../README.md)。
