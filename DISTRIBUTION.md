# look2.0 分发与验证

## 【未读】当前发布与验收范围（2026-10-16 核对）

【未读】现行源码和DSH、MCP、Web三包均为 **2.0.25**，以[发布清单](release/manifest.json)和[SHA256SUMS](release/SHA256SUMS)为准。第30轮本机UI阶段完成，整体项目未完成；当前入口为[项目工作记忆](工作记忆.md)及[第30轮交付](look2-workspace/acceptance-20261014/ui-30/delivery-summary.md)。

【未读】2.0.25已记录434/434、三构建、44包文件一致性和tools0.2.0-rc.2临时消费者smoke；该轮没有重演tools0.1、官方双CLI或真实DSH会话。旧轮结果不能提升为新包的全范围验收。千星和旧站工程仍暂缓，真实DSH会话、Desktop插件及Docker仍取消，未公开发布。

【未读】本轮只清理release中的24个旧包并整理说明，未构建、安装、回归、启动服务或试玩；当前三包字节与原清单一致。原始报告、检查点及冻结清单保留原值，文档与旧包路径差异见[清理清单](archive/2026-10-16-旧发布包清理.json)。归档取证包不在本轮删除范围。

## 【未读】各轮历史记录与安装背景

【未读】以下各轮中的“当前”“暂停”“待验”和release路径均按形成时点理解，不作为最新状态；旧包身份仍可从各轮清单查阅，不代表原release路径仍存在。

【未读】2026-10-12第28轮：**2.0.24本机参考范围修复与验证完成，未公开发布，项目整体未完成；用户已恢复且未再次要求暂停**。用户明确按参考站实际PSD/Spine支持范围收口；特殊合成/全骨架及跨骨骼层序等参考声明限制保留为支持边界，不作为全格式开发前置。修复PSD首选蒙版单选、禁用不回退、缺像素/越界默认色和缓存提示。资产40/40、完整434/434及三构建、当前三包41文件回读、双tools各3/3与官方双CLI当前2.0.24隔离Git安装/注册/配置/installed smoke均通过。原生Worker三份合成二进制PSD的固定alpha与真实PSD18层像素/保存重开限定复验通过；真实PSD没有realMask，三夹具不冒称作者真实复杂样本。Dragon保留第27轮2.0.23限定证据，当前editor.js同哈希且相关路径未改，不为标签重测。实机、原作者工程及未验证真实宿主继续待验；Desktop/Docker继续取消。详见[本轮报告](look2-workspace/acceptance-20261012/resume-28/delivery-summary.md)、[汇总](look2-workspace/acceptance-20261012/resume-28/run-summary.28.json)、[检查点](look2-workspace/acceptance-20261012/resume-28/resume-checkpoint.28.json)及[范围合同](docs/reference-parity.md)。临时服务和页面已关闭，旧记录保留原时点。

【未读】2026-10-12第27轮：**2.0.23本机阶段完成后按用户要求暂停，未公开发布，项目整体尚未完成**。产品源码/锁未变；第26轮427/427及Web/DSH构建沿用，MCP本轮构建通过。当前release三包均2.0.23，包内41个非清单文件与源/构建逐字节相等；双tools各3/3、官方CLI0.1.7-rc.2与0.2.0-rc.2的新临时profile Git prepare/plugin add/dump-config/installed smoke均exit0。原生PSD/Dragon保存重开site导出字节一致，PSD18层含6矢量缓存与Dragon47贴图含16旋转区域像素核对通过限定范围，不代表PSD完整样式、完整骨架视觉或千星实机。Desktop与Docker验收已由用户取消；千星环境和旧站原始工程尚未准备。独立结论、失败/成功日志及剩余以[本轮报告](look2-workspace/acceptance-20261012/resume-27/delivery-summary.md)、[机器汇总](look2-workspace/acceptance-20261012/resume-27/run-summary.27.json)与[检查点](look2-workspace/acceptance-20261012/resume-27/pause-checkpoint.27.json)为准。4212服务与验收页已关闭；暂停后不继续开发或验收，只有明确恢复后才继续。第26轮及更早记录保留原身份。

【未读】2026-10-12第26轮：**2.0.23源码候选，按用户要求暂停保存，未公开发布，项目整体尚未完成**。PSD矢量缓存烘焙告警与禁用蒙版仍应用缓存的问题已修复；资产33/33、暂停前启动的完整427/427及Web/DSH构建通过。MCP新构建、新包生成/安装、双CLI和原生复验未执行；当前release/manifest.json与三包仍为已验证的2.0.22，不能把下方第25轮分发证据外推为2.0.23。旧站样本调查未取得原始UI工程，其他外部门槛与Desktop用户取消保持。暂停后不新增开发、安装、验收或试玩，待用户明确恢复；见[第26轮暂停报告](look2-workspace/acceptance-20261012/resume-26/delivery-summary.md)与[检查点](look2-workspace/acceptance-20261012/resume-26/pause-checkpoint.26.json)。

当前是本地独立源码目录，无独立远程仓库或公开 npm 发布。原 Look 的发布历史、包名与远程地址不作为 look2.0 安装入口。

【未读】2026-10-12第25轮：**2.0.22本地候选，本轮修复与本机验证完成，未公开发布，项目整体尚未完成**。修复Spine旋转atlas的页内裁切尺寸与还原方向；资产26/26、完整420/420、Web/DSH/MCP三构建通过，三包在tools0.1.0-rc.6及0.2.0-rc.2下各3/3安装通过，官方CLI0.1.7-rc.2与0.2.0-rc.2完成本候选隔离Git安装/注册/配置及installed smoke。包哈希见release/manifest.json与[本轮包核对](look2-workspace/acceptance-20261012/resume-25/evidence/package-audit.25.json)。原生Dragon的47张图集贴图含16旋转区域完成独立像素映射核对，保存重开site导出字节一致；save与磁盘archive仅JSON相等。跨骨骼层序/复杂Spine完整视觉、PSD完整语义、千星、独立旧站导出及Docker仍待验，Desktop插件验收仍用户取消。本轮沿用授权的隔离模拟器自动play/截图，没有千星实机或手动试玩。详见[第25轮报告](look2-workspace/acceptance-20261012/resume-25/delivery-summary.md)与[阶段检查点](look2-workspace/acceptance-20261012/resume-25/resume-checkpoint.25.json)；[第24轮暂停记录](look2-workspace/acceptance-20261011/resume-24/pause-checkpoint.24.json)保留历史身份。

【未读】2026-10-11第22轮：**2.0.20 本地候选的官方CLI 0.1.7-rc.2、0.2.0-rc.2隔离Git安装均通过，exit0**。分别完成源码prepare、plugin list/add、dump-config及installed smoke；用户已明确允许其中隔离Node模拟器自动化play／截图。root peer、锁和产品源码未变，沿用第21轮408/408、Web/DSH/MCP三构建及三包双工具版本安装结果。DSH Desktop、千星实机、真实复杂样本和Docker构建仍待验；当前三产品版本及包哈希以release/manifest.json为准，未公开发布。详见[本轮报告](look2-workspace/acceptance-20261011/resume-22/delivery-summary.md)和[机器汇总](look2-workspace/acceptance-20261011/resume-22/run-summary.22.json)；[第21轮暂停检查点](look2-workspace/acceptance-20261011/resume-21/pause-checkpoint.21.json)仅是历史冻结基线。

【未读】两次成功临时Git源快照各214项，记录更新前捕获的哈希全部匹配；两临时DSH_HOME已清理，用户profile未改。pnpm store仍共享，Gitless快照可能包含archive历史资料。旧CLI首次沙箱安装锁拒绝日志与成功重试分开保存；新CLI曾因play／截图授权不足被自动审核拒绝，明确授权后获准执行。安装后自动化模拟器播放不代表Desktop、手动页面试玩或千星实机通过。

两个隔离安装脚本接受`LOOK2_DSH_TOOLS_VERSION=0.1.0-rc.6`或`0.2.0-rc.2`，未设置时使用root开发依赖声明的版本。CLI Git安装检查会校验CLI实际解析到的工具包符合对应 peer 范围：旧线为`^0.1.0-rc.6`（例如CLI 0.1.7内的`0.1.7-rc.2`），新线要求`0.2.0-rc.2`。CLI profile按自身依赖安装，不额外注入工具包。验证两代CLI时分别传入对应版本和CLI绝对路径，每次脚本运行使用新的临时`DSH_HOME`：

```powershell
$env:LOOK2_DSH_TOOLS_VERSION = '0.1.0-rc.6'
corepack pnpm test:git-install -- '<0.1 CLI的lib/bin.js绝对路径>'
$env:LOOK2_DSH_TOOLS_VERSION = '0.2.0-rc.2'
corepack pnpm test:git-install -- '<0.2 CLI的lib/bin.js绝对路径>'
Remove-Item Env:LOOK2_DSH_TOOLS_VERSION
```

包安装检查也可用相同环境变量分别指定工具版本。测试、构建、安装证明不等于手动游戏试玩或千星实机验收。

【未读】以下为历史验收记录，不能作为2.0.21本轮验收结果；其中Desktop待验要求已由第23轮用户取消决定取代。

【未读】2026-10-08当前阶段按用户最新要求收口后暂停，源码2.0.11关键帧输入/颜色合并修复已通过全量331/331；Web/DSH由全量测试入口构建，MCP独立构建。8构建与12源码SHA256见acceptance-20261008/served-build.1.json；最终release-manifest.1三包SHA256匹配，packages.1三产品独立安装全部PASS、exit0。匹配CLI0.1.7-rc.2的git-cli-smoke.2完成Git源码prepare、plugin add、dump-config及installed smoke，实际安装2.0.11、exit0；首次沙箱pnpm共享锁error5见.1，未视为产品失败。验收后20项源码/构建及三包hash仍一致，详见[最终分发验收](look2-workspace/acceptance-20261008/distribution-final.1.md)。临时Git源码逐文件hash未保留，不据此声称完整临时检出快照与当前目录逐文件相同；安装后只补验收文档和记忆。最终候选以release/manifest.json为准，下方2026-10-05暂停及其结果均为历史。

【未读】2026-10-05本轮只做编辑器、构建和安装验证，用户要求完成当前阶段后暂停保存。2.0.10全量327/327、Web/DSH/MCP构建通过，8构建与12源码hash见served-build.6；最终manifest.7三包hash、包内版本和构建均一致，packages.5独立安装全部通过。匹配DSH CLI0.1.7-rc.2的.4日志实际安装版本为2.0.10，Git源码prepare、plugin add和dump-config通过；临时源码hash未留，不据此声称逐文件相同，之后仅改文档/示例/打包材料。详见[最终分发验收](look2-workspace/acceptance-20261005/distribution-check.3.md)。2.0.9 manifest.6/packages.4/git-install.6仅属上一候选，以下暂停段落为历史检查点。

2026-10-05按用户最新“尽快暂停保存”停止后续验收。最后基础Inspector修复后全量321/321通过，Web/DSH/MCP均构建（served-build.4）；暂停时只按现有构建保存最新三包，`release-manifest.5.json`与实际hash一致，最终安装/Git/CLI复验未执行。修复前`.4`三包、`packages.2.log`、`git-install.3.log`及真实DSH CLI0.1.7-rc.2默认注册/配置检查`dsh-cli-0.1-smoke.2.log`均通过，旧包另存`intermediate-packages.4/`；这些中间证据不推及`.5`。当前阶段/完整37项未完整收口，须用户明确恢复；候选包不表示公开发布。

【历史分发清单：2.0.11】

| 产品 | 清单位置 | 包名 | 本轮版本 |
| --- | --- | --- | --- |
| DSH | 根 package.json | look2-dsh-plugin | 2.0.11 |
| Web | web/package.json | look2-web | 2.0.11 |
| MCP | mcp/package.json | look2-mcp | 2.0.11 |

三个产品共用 Studio、Lua Runtime、Authoring/GIA 和 Controller。宿主仅适配路由、工具或协议，不另建引擎。Web 与 DSH 共用 React 编辑器，独立打包图元与 PSD classic Worker；DSH 从宿主取得 React，Web 自带 React。Worker 与 ag-psd 都随本地包交付。

## 打包

```powershell
node scripts/build.mjs
corepack pnpm test
corepack pnpm pack:release
corepack pnpm test:packages
```

打包按各清单 files 白名单生成 release/staging，去除开发依赖及安装生命周期脚本，拒绝运行依赖中的 workspace/file/link。release/manifest.json 记录本批三个 tarball，SHA256SUMS 记录校验值。重复打包保留旧 tarball，以 manifest 为准。

test:packages 在源码目录外安装三个包，检查 Worker、静态页面、PNG、GIA、编辑保存、MCP stdio 与 Skill/预设。自动化 Runtime 输入与截图检查不等于手动游戏试玩或千星实机验收。

## 源码安装检查

```powershell
corepack pnpm test:git-install
```

此脚本建立不含 dist 的临时 Git 源并执行真实 Git 依赖安装；原项目无 Git 元数据时从当前目录收集文件，排除依赖、构建及代码中列明的工作区/缓存目录。当前排除列表没有`archive`，执行前须考虑该目录可能进入临时快照。不会给当前项目建立仓库、修改原 Look 历史或发布远程内容。

可传入已有 DSH CLI 的 lib/bin.js 绝对路径，在临时 DSH_HOME 中额外核查 plugin add 与配置注册：

```powershell
node scripts/smoke-git-install.mjs <DSH-CLI-lib-bin.js绝对路径>
```

【未读】本机CLI路径、实际执行结果与当前限制以[第22轮报告](look2-workspace/acceptance-20261011/resume-22/delivery-summary.md)及其原始日志为准；第21轮暂停检查点保留此前候选和CLI定位历史。

【历史验收，仅覆盖2.0.11和CLI 0.1.7】本轮匹配CLI为官方`@deepseek-ai/dsh@0.1.7-rc.2`，在隔离DSH_HOME完成`plugin add`和`--dump-config`；实际profile使用pnpm12.9.1，源码prepare使用pnpm10.15.0。安装脚本按profile声明或隔离consumer实测的pnpm版本设置临时构建白名单：低于10.26使用`onlyBuiltDependencies`，10.26及之后使用Git来源和精确commit的`allowBuilds`，并允许必要的esbuild。没有修改用户profile或全局策略，版本分支由独立定向断言覆盖。规则来源见[pnpm官方文档](https://pnpm.io/settings/build#allowbuilds)。

【未读】【历史阻断证据：旧peer声明期间】官方CLI`0.2.0-rc.2`当时已完成Git源码prepare/安装，但因插件peer `@deepseek-ai/dsh-tools: ^0.1.0-rc.6`被版本门禁拒绝，未完成注册或配置检查。第21轮2.0.20双peer候选因暂停尚未执行CLI验证；第22轮两代CLI已完成且exit0，旧阻断不能代表本轮结果。没有执行`allow-version --accept-risk`。CLI版本处理见[官方源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts)。

## 本地使用

DSH 用 manifest 中对应 tarball 的绝对路径执行 `dsh plugin --profile web add`，再重启宿主。根 exports 与 bundle 定位包内 dsh-plugin/dist、Skill 和预设。

Web 用 `node web/dist/server.js --workspace ./look2-workspace --port 4174`，或安装本地 Web tarball 后用 `look2-web`。MCP 用 `node mcp/dist/index.js --workspace ./look2-workspace`，或安装本地 MCP tarball 后用 `look2-mcp`。

图片缓存位于可写工作区或 DSH 用户目录，而非安装包内；可用 LOOK2_ASSET_CACHE 改路径。工程嵌入的用户图片不依赖该缓存。默认 Web 为单个可信操作者服务；绑定外部地址需配置 QXQY_WEB_PASSWORD 与 HTTPS。

功能验收清单见 [docs/reference-parity.md](docs/reference-parity.md)，实际通过项、失败项及实机边界见 [工作记忆.md](工作记忆.md)。包适用 [GPL-3.0-only](LICENSE)。
