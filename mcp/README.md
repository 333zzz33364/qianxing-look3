# look2.0 MCP

本地 stdio 服务名和包名为 `look2-mcp`，工具名以 `look2_` 开头，共用 Studio、Lua Runtime 和 GIA 核心，不依赖 DSH。

```powershell
node scripts/build.mjs mcp
node mcp/dist/index.js --workspace ./look2-workspace
```

在支持 MCP stdio 的客户端中，将 command 设置为 `node`，args 设置为本项目 `mcp/dist/index.js` 的绝对路径、`--workspace` 和工程工作区绝对路径。不要把上面的相对路径直接复制到工作目录不明的客户端。stdout 仅输出 MCP JSON-RPC，诊断输出到 stderr。

预构建包从项目根 `release/manifest.json` 查找后本地安装，命令为 `look2-mcp --workspace <工作区>`；当前没有公开 npm 安装渠道。

主要工具：`look2_project_open/save`、`look2_studio_get/patch/transaction/history/template`、`look2_animation_set/export`，以及试玩、输入、截图、日志和自动化用例工具。事务与历史传入最新 expectedRevision；动画状态、控件和资源共用撤销栈。导出支持站点 JSON、Timeline Data/Lib、PrimitiveData/Lib、SVG/CSS、GIA 和完整存档。

MCP 与 Web 可指向同一工作区，Web `/` 可观察已保存工程。各客户端草稿独立，写盘前检查文件变化；同一路径发生冲突时加载新文件后重试。正式保存与导出不会自动启动游戏试玩。

完整功能及导入千星说明见 [项目 README](../README.md)，实际验收结果见 [工作记忆](../工作记忆.md)。
