# 千星look3 构建与分发

1. 【未读】**版本与产品。** 当前源码版本3.0.0；三个产品为 `look3-web`、`look3-mcp`、`look3-dsh-plugin`。来源固定提交见[来源清单](docs/上游/来源.json)。核心包保留内部名称，不单独发布。
2. 【未读】**构建。** 在本目录运行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`。构建含共享Runtime/Studio/界面，以及拟合和PSD Worker。
3. 【未读】**本地包。** `pnpm pack:release` 生成三包、`release/manifest.json` 与 `release/SHA256SUMS`。`pnpm test:packages` 在源码目录外独立安装，分别核对DSH tools 0.1/0.2两个宿主API；不安装到用户现有宿主配置。
4. 【未读】**源码安装。** 维护根prepare、exports或DSH源码入口后执行 `pnpm test:git-install`；该检查使用临时目录与profile。真实用户宿主、Desktop和Docker的运行结果另行记录，不由源码安装smoke代替。
5. 【未读】**隔离。** 上游参考检出、用户存档、历史证据、Git元数据和依赖缓存不入运行包。字体文件不随包复制。包检查核对版本、许可、资产路由、编辑/保存、Worker、PNG、GIA以及MCP/Web桥接。
6. 【未读】**启动。** Windows入口为上级 `千星look3.cmd`；默认工作区 `look3-workspace/`，端口从4260开始。其他工具调用时显式指定同一工作区。不会自动升级、停止或替换原Look2服务。
7. 【未读】**发布。** 本地打包不触发npm/GitHub发布；本项目不沿用原作者仓库的发布身份。任何外部发布需独立准备目标与授权。本轮真实验证以[工作记忆](工作记忆.md)及本轮日志为准。
