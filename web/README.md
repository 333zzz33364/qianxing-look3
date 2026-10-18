# look2.0 Web

默认页面 `http://127.0.0.1:4174/editor`，完整存档工作区与原 Look 分离。Node.js 22+ 源码启动：

```powershell
node scripts/build.mjs web
node web/dist/server.js --workspace ./look2-workspace --port 4174
```

本地预构建包可从项目根 `release/manifest.json` 查找后安装，命令为 `look2-web --workspace <工作区绝对路径> --port 4174`。look2.0 当前没有公开 npm 安装渠道。

`/editor` 是动画与 Look 全功能编辑器；`/` 监听已保存存档作预览。正式文件只在显式保存时写入，浏览器自动草稿保存在 IndexedDB。其他客户端修改同一磁盘文件时，编辑器会拒绝覆盖，重新加载后再编辑。

`POST /api/play` 与 `/editor/api/play` 使用 `{ "action": "start", "args": { ... } }` 启动试玩。`args` 可选 `asset: "server" | "client"`、`templateRootId`、`animationId` 和 `expectedRevision`，也可传 `canvasId`、`playerCount`、`viewPlayerIndex`。省略 `asset` 时沿用工程现有自动分流；显式 `server` 运行完整服务端界面，显式 `client` 运行当前客户端模板或 `templateRootId` 指定的模板。`templateRootId` 只用于 `client`，`animationId` 可指定客户端模板实例的启动动画。`expectedRevision` 必须是当前工程版本，冲突会在替换运行 Worker 前返回。

参数：`--workspace <dir>`、`--file <工作区相对路径>`、`--host <host>`、`--port <port>`、`--open`。工作区默认取 `QXQY_WORKSPACE` 或当前目录，监听默认 `127.0.0.1:4174`。代码更新后重启服务以载入新宿主实现。

图片目录和素材通过同源 `/look2-assets/` 访问参考站源。缓存默认在工作区 `.look2-image-cache/`，可设置 `LOOK2_ASSET_CACHE`；`LOOK2_IMAGE_PROXY` 可指定素材代理，继而读取 HTTPS_PROXY / HTTP_PROXY，直连失败时尝试本机 65532 代理。网址导入图片保存为工程内数据，避免重开依赖原网址。图元与 PSD Worker 都由服务提供，无需外部 Worker CDN。

绑定非回环地址需设置 `QXQY_WEB_PASSWORD`，登录用户名为 `simulator`，对外访问应使用 HTTPS 反向代理。默认面向单个可信操作者，不提供多用户工程权限隔离。所有业务页面与 API 均受认证保护，写请求校验 Origin 与工作区路径。

```powershell
$env:QXQY_WEB_PASSWORD = '替换为自己的长口令'
node web/dist/server.js --workspace ./look2-workspace --host 0.0.0.0 --port 4174
```

完整功能、操作说明及当前验证范围见 [项目 README](../README.md) 与 [工作记忆](../工作记忆.md)。
