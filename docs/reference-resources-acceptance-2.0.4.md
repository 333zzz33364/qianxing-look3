# look2.0 2.0.4 图元资源阶段验收

日期：2026-10-02  
验收范围：阶段 2（图片与图元）。浏览器验收代理只负责交互验收和保存检查点；RS06 首次复验未通过后，主代理修复了普通图片控件读取拟合图元的路径并重建，再由验收代理完成第二次测量。阶段 1 的双尺寸整体、阶段 3 的动画/PSD/Spine、自动游戏试玩均不在本轮范围内。

## 环境与入口

- 浏览器入口：`http://127.0.0.1:4185/editor`，页面标题 `look2.0 · 动画工作台`。主代理确认 `GET /health` 返回 `{status:"ok"}`，`GET /editor` 返回 200。
- 资源管理器从顶栏“图片”打开；检查点使用顶栏“保存”按钮由应用写入 `look2-workspace/` 下的存档文件。本轮最新导出保存为 `look2.0.1.save.json`。
- 浏览器控制台有一个与功能无关的 `/favicon.ico` 404。另有两条由本轮 canvas 像素读取触发的 `willReadFrequently` 性能提示；没有观察到应用脚本异常。

## 验收结果

| 项目 | 结果 | 浏览器证据 |
|---|---|---|
| RS03 默认值和按资源保存 | 通过本轮切换验证；未做重新打开工程后的二次验证 | 对 `100005.png` 将选项改为 37 个、分辨率 64、1 worker、仅三角形、关闭透明背景；切换到 `acceptance-two-color.png` 再切回，改动值仍在。点“恢复默认”后再切换回来，显示 400 个、512、16 workers、椭圆和矩形开启、三角形关闭、透明背景开启。随后保存中间与最终工程检查点。 |
| RS05 每图参数和批量拟合 | 通过 | 将 `100001` 设为 23/64/1、仅椭圆、透明背景；将 `100002` 设为 29/128/3、仅矩形、不透明；切换资源后分别确认设置保留。点“批量拟合未完成资源”后页面显示“批量拟合完成；成功 3 张，失败 0 张”；列表分别显示 `100001` 9 个、`100002` 1 个、`100005.png` 400 个图元。 |
| RS06 同资源双控件 contain | 修复版通过；PID 76172 版的首次复测未通过 | 在修复版重载页面并从 final 存档导入后，将正方形 `acceptance-checker.png` 图元绑定到逻辑 160×64 与 64×160 的两个图片控件，面板确认“绑定 2 处”并点击“全部显示拟合”。拟合资源预览 DOM 显示 `img.currentSrc` 为 `data:image/svg+xml` 且 natural size 为 256×256 px（原资源项 MIME 为 image/png），确认当前观察的是拟合 SVG。DOM 控件框分别为 47.69×19.02 px 和 19.08×47.53 px，画布 backing store 为 48×19 px 和 19×48 px。对 canvas 读取 alpha 像素边界，横向控件可见区域为 x=14..33 / y=0..18（约 20×19 px，左右各留 14 px）；竖向控件为 x=0..18 / y=14..33（约 19×20 px，上下各留 14 px）。两者均为居中的约 19×19 px 正方形内容，符合 contain。截图：`look2-workspace/rs06-contain-stage2-20261002-build2.png`（整页）与 `look2-workspace/rs06-contain-stage2-20261002-build2-canvas.png`（画布区域）。PID 76172 版的资源像素曾占满画布长边，主代理修复普通图片控件未读取 fitData 的路径后，上述可见区域出现中心留白并通过本项。 |
| RS07 三形状 SVG/CSS 导入导出与 undo | 通过 | 对 `acceptance-checker.png` 设 80 个、分辨率 64、椭圆/矩形/三角形全选并生成，页面显示“已生成 80 个图元”。从资源面板导出 CSS 和 SVG，导出的文件中 SVG 含 29 个 `<ellipse>`、17 个 `<rect>`、34 个 `<polygon>`；CSS 含 29 个 `border-radius:50%` 椭圆规则、34 个 `clip-path:polygon(...)` 三角形规则。通过各自“导入 CSS / 导入 SVG”控件导入三形状文件，均出现成功状态。另将 UI 导出的 `100005.png.css` 导入该资源后计数由 80 变为 400，撤销后回到 80；导入 `100005.png.svg` 后同样由 80 变为 400，撤销后回到 80。 |
| RS08 非法 CSS 拒绝 | 通过拒绝/保留旧结果验证 | 上传测试文本 `not a valid Shaper CSS {`；页面 alert 显示“CSS 规则格式无效”。资源列表仍显示 `100005.png` 为 400、`acceptance-checker.png` 为 80，旧图元未被替换。拒绝后没有另行点击 undo；由于导入被拒绝且计数不变，本轮只记录为无状态变更，不声称验证了失败导入的 undo 历史。 |

## 证据和检查点

- 浏览器导出文件：工作区 `.playwright-mcp/acceptance-checker-png.css`、`.playwright-mcp/acceptance-checker-png.svg`、`.playwright-mcp/100005-png.css`、`.playwright-mcp/100005-png.svg`。前两份分别用于三形状导出统计与导入；后两份用于资源替换和 undo 验证。
- 非法 CSS 可复测输入：`look2-workspace/acceptance-invalid-shaper-stage2.css`（27 字节，内容为上述无效文本）。
- RS03/RS05 中间检查点：`look2-workspace/acceptance-rs-stage2-20261002-rs03-rs05.save.json`（289,914 字节）。
- 应用中点击顶栏“保存”生成的有效最终检查点：`look2-workspace/look2.0.1.save.json`（310,827 字节）。已使用 PowerShell `Get-Content -Raw -Encoding utf8 | ConvertFrom-Json` 成功解析，`meta.name` 可回读为“未命名存档”。
- 原 `look2-workspace/acceptance-rs-stage2-20261002-final.save.json`（310,829 字节）与新导出副本 `look2-workspace/look2.0.1.save.json`（310,827 字节）均保留。两个文件都用 PowerShell `Get-Content -Raw -Encoding utf8 | ConvertFrom-Json` 成功解析，`meta.name` 都可回读为“未命名存档”；之前默认 ANSI 读取引起的解析错误为编码误报。原始基线 `look2-workspace/acceptance-rs-stage2-20261002.save.json`（118,758 字节）保持不变。第一次保存时误把 `look2-workspace/` 重复写入路径，生成的嵌套副本已通过解析绝对路径后删除；中间检查点仍保留。

## 受限项与后续

RS06 已在修复版完成第二次复验并通过，可见区域像素测量与两张截图已记入上表。原 final 存档与应用新导出的 `look2-workspace/look2.0.1.save.json` 都已指定 UTF-8 并验证 JSON 可解析；两个版本均保留。除 RS06 外，本轮没有进入阶段 1 或阶段 3 测试。

此前已完成且本轮未重跑的阶段 2 项：本地 PNG 与 URL 图片嵌入、资源引用搜索/改名/删除/undo、断开 sprite 路径后的首屏 64 张缩略图展示、拟合取消/关闭及删除过期结果竞态、画布高度 CSS 修复。它们沿用既有阶段验收记录。
