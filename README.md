# dsh-voice-notify

[**简体中文**](README.md) | [English](README.en.md)

[![check](https://github.com/TangAu-relife/dsh-voice-notify/actions/workflows/check.yml/badge.svg)](https://github.com/TangAu-relife/dsh-voice-notify/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform: Windows](https://img.shields.io/badge/platform-Windows-0078d4.svg)](#安装)

**一轮对话真正结束时，用中文语音播报一句提醒。**

给 DSH 用的宿主侧（Host half）插件：挂宿主原生的「轮次收尾」扩展点，随机播一条
随包内置的中文语音（晓晓 · 温暖，20 条叠词短句），不引任何第三方音频依赖。

```
主人主人，任务完成啦～      都弄好啦，快来看看嘛～
事情办得妥妥的，夸夸我嘛～   报告报告，全部搞定啦～
主人主人，我棒不棒呀～
好啦好啦，全都做完啦～    快夸夸我呀，我可厉害啦～
叮咚，任务完成，撒花撒花～  主人主人，辛苦你啦，也夸夸我嘛～
收工收工，要不要歇一歇呀～
办完啦办完啦，快来看看嘛～      才不是特意为你做的呢，快收下～
别太感动哦，我只是顺手做的～    搞定啦搞定啦，主人要不要抱抱～
忙完啦，主人记得喝水水哦～      叮铃铃，任务交卷啦～
夸夸我夸夸我，不然我要闹啦～    圆满完成，给我一点掌声嘛～
主人主人，累不累呀，歇一会儿嘛～  做完啦，主人快摸摸我的头～
```

---

## 它做什么

| 行为 | 说明 |
|---|---|
| 挂接缝 | `agent/turn-stopping`（宿主 **serial** 扩展点，一轮真正收尾时派发） |
| 放音 | 随机播一条内置 WAV；可选追加自己的语音目录 |
| 不吵 | 子代理轮次默认**不响**；`minIntervalMs` 内不重复 |
| 不阻塞 | `spawn` 后 `unref()`，立刻返回，绝不等它放完 |
| 不致命 | 任何异常都吞掉只记日志 —— 提醒插件绝不能影响任务收尾 |
| 可自证 | 从 apply / 收到事件 / 跳过原因 / spawn，到 PowerShell 的真实播放秒数，逐行落盘 |

---

## 从 GitHub 安装

```powershell
git clone https://github.com/TangAu-relife/dsh-voice-notify.git
cd dsh-voice-notify
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1        # guardian 模式（推荐）
# 或者
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Mode roster
```

卸载：`.\install.ps1 -Uninstall`（加 `-Purge` 连落地副本一起删）。

**要求**：Windows + PowerShell 5.1+、已装 DSH。放音走 .NET `SoundPlayer`（winmm），
目前只支持 Windows —— 非 Windows 平台上插件会打印一条警告并静默停用。

要自己重新合成语音，工作区里配套的 `speak.ps1`（在线 edge-tts，失败回退离线 piper）
不是本仓库的一部分，见仓库 README 的「换成你自己的语音」。

---
## 安装

### 方式一：守护热挂载（本机 desktop profile 正在用）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1        # 首次安装：立即生效
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Hot   # 改了代码：不重启也生效
```

脚本做四件事，**全程不跑 pnpm**（因此不会扰动正在运行的 profile 依赖树）：

1. 把插件**落地成一份带时间戳的真实副本**：`$DSH_HOME\plugins\voice-notify\deploy-<ts>\`；
2. 在 `<profile>\node_modules\` 建一个指向该副本的 **junction**，并清理本插件家族的旧 junction；
3. 把副本的包名改成实际使用的**说明符**（`-Hot` 时带时间戳，见下文「坑 3」）；
4. 通过守护自己的接口 `POST /guardian/api/staged` **热挂载**，成功即转正
   （写进 `$DSH_HOME/guardian/state.json` 的 `promoted`，以后每次启动自动恢复）。

### 方式二：正式名册（profile 里没有守护插件时）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode roster
```

等价于手工两步：把包名加进 profile `package.json` 的 `dependencies`（`link:` 指向落地副本）
与 `dsh.profile.bundles`。本包自带的 `cordis.patch.yml`（由 `package.json` 的
`dsh.bundle.patch` 声明）会在该 profile 里插入 `voice-notify` 行。**此方式需要重启 DSH**。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall          # 移除条目 + junction
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Purge   # 连落地副本一起删
```

---

## 配置

配置写在挂载条目的 `config` 里（守护接口的 POST 体，或名册 profile 的 patch 行）：

```yaml
- id: voice-notify
  name: dsh-voice-notify
  config:
    enabled: true            # 总开关
    includeSubagents: false  # 子代理轮次是否也响
    minIntervalMs: 4000      # 两条提醒的最小间隔（吸收同时收尾的多个轮次）
    clip: ''                 # 固定一条，如 'done-3'；留空＝随机
    clipDir: ''              # 额外语音目录，*.wav 一起进随机池
    voiceScript: ''          # 覆盖放音脚本（默认包内 lib/play.ps1）
```

---

## 设置页（图形界面）

![设置页：固定语音的句子胶囊列表](docs/settings.png)

插件带**浏览器半侧**：在 **设置页里单开一栏**（`settings.section` 插槽，导航名「语音提醒」）。

- 总开关、子代理轮次是否也提醒、最小间隔（毫秒）
- 固定语音（下拉框 + **可点选的句子胶囊列表**：点一下固定、双击试听，20 句一眼全看见）、额外语音目录、高级里的放音脚本
- 下拉框弹出层是**原生白底**，所以 `<option>` 必须写死深色文字（见 `lib/client.js` 的 `styles.option`）
- **试听**按钮（不受总开关影响，关着也能试听）
- **播报日志尾部**：页面里直接看 `PLAY/FAIL/MISS` 硬证据，不用翻文件

保存后**立即生效**，不需要重启宿主：配置写到 `$DSH_HOME/plugins/voice-notify/config.json`，
优先级 **这个文件 > 挂载条目的 config > 默认值**（设置页是权威的）。

> 首次装完要**刷新一次页面**：客户端模块清单随首页一起注入。

浏览器半侧靠三个同源接口工作（宿主 `ctx.webServer` 注册）：

| 接口 | 作用 |
|---|---|
| `GET /voice-notify/config` | 读当前配置 + 内置语音清单 + 两个文件路径 |
| `POST /voice-notify/config` | 写配置（逐字段白名单 + 类型校验 + 范围夹取，未知字段丢弃），落盘并热生效 |
| `POST /voice-notify/test` | 立刻试听一条（`{"clip":"done-3"}` 可指定） |
| `GET /voice-notify/log?lines=40` | 播报日志尾部（上限 200 行） |

实现依据（都有据可查）：客户端模块是 `window.__ModuleLoader__.load({id, factory})` 的**普通 JS**，
不需要构建工具，React 从浏览器模块表 `require('react')` 拿（官方模板同款）。
**模块 id 必须精确等于包名**（宿主 `dsh-client-modules` 硬校验），所以热更新换包名时
`install.ps1` 会同步改写 `lib/client.js` 里的 id（标记 `// __PKG_ID__`）。
宿主扫描的是 **Loader 的活条目**而非 profile 名册，所以守护热挂载也照样被发现；
`exports` 里**必须**有 `"./package.json"`，否则宿主读不到 `dsh.client` 声明。

---
## 换成你自己的语音

1. **丢文件**：把任意 `*.wav` 放进一个目录，配置 `clipDir` 指向它，立刻进随机池（每次都重扫）。
2. **换内置**：替换 `assets/done-*.wav`（16bit PCM WAV，建议 22050Hz 单声道）。
3. **重新合成**：本工作区的 `speak.ps1`（在线 edge-tts，失败回退离线 piper）可批量合成，
   `notify.ps1 -Warm` 能把整组短句预合成后再拷进 `assets/`。

---

## 验证（实测证据）

**播报日志**：`$DSH_HOME/voice-notify.log` —— 每一行都是可核对的证据：

```
21:15:01  [plugin] 已挂载：监听 agent/turn-stopping，候选语音 5 条，最小间隔 4000ms，日志 …
21:16:15  [plugin] 收到 agent/turn-stopping：turn=15 agentId=session-… subagentDepth=undefined
21:16:15  [plugin] spawn 放音进程 pid=2588  →  done-3.wav
21:16:18  PLAY  done-3.wav  2.82s  …\assets\done-3.wav
21:16:18  [plugin] 放音进程退出 code=0 signal=null
```

`PLAY` 后的秒数是 `PlaySync()` 的**真实阻塞时长**：与音频时长相当即为真出声，
明显偏短就是静默失败。`[plugin]` 行由插件用 node 侧 `fs` 写，`PLAY`/`FAIL`/`MISS`
行由 play.ps1 写 —— 两段证据分开，一眼能看出断在哪一环。

**离线自测**：工作区 `tools/test-voice-notify.mjs` 用假 ctx 加载本模块，模拟三条用例
（子代理轮次 / 根会话轮次 / 间隔内重复），验证过滤与去重逻辑。

---

## 实测踩到的三个坑（重要，别再踩）

### 坑 1：`detached: true` 会让 powershell.exe「退出码 0 但什么都没干」

在**运行中的宿主里**做过三组对照：

| spawn 配置 | 子进程存活 | 命令是否真的执行 |
|---|---|---|
| `detached: true` + `stdio:'ignore'` | 393ms / 74ms | **否**（marker 文件不生成）❌ |
| `detached: false` + `stdio:'ignore'` | 381ms | **是** ✅ |
| `spawnSync` + 管道 | 351ms | **是** ✅ |

`detached:true` 在 Windows 上就是 `DETACHED_PROCESS`：无控制台的 powershell.exe
走这条路径不干活。**不阻塞轮次用 `unref()` 就够了，不需要 detached。**

### 坑 2：宿主进程里 `$env:DSH_HOME` 是 `undefined`

Electron 起的 `dsh-desktop-host` 没有这个变量，只靠它 play.ps1 会把日志默默写进 `%TEMP%`，
表现为「哪儿都找不到日志」。现在由 node 侧用 `os.homedir()` 兜底算出绝对路径，
经 `-LogPath` 显式传给脚本。

### 坑 3：宿主按**包名**缓存 ESM 模块，重挂载不会换代码

实测：把 junction 重指到新副本、再经守护重新挂载，跑的还是最初那份代码
（`dsh-app-boot` 的 `state.esm` 以说明符为键缓存）。所以：

- 普通安装（规范名）改代码后要**重启 DSH**；
- `install.ps1 -Hot` 用带时间戳的新包名（如 `dsh-voice-notify-live-20261010-211845`）
  强制全新导入，因此在运行中的宿主里**立即生效**。

### 另外一个反直觉点：守护的暂存文件可能"不生效"

守护的热加载有 `fs.watch(暂存文件)` 与 4 秒轮询两路，**两路都要求 `shared.ready`**。
实测桌面端该标志可能为 false（两路一起空转，写暂存文件毫无反应）。
守护自己的 `POST /guardian/api/staged` 会直接调 `scanStaged()`，是可靠通道 ——
install.ps1 优先走它。

---

## 设计与取证

每条接线都有源码级证据（已装宿主 `0.2.0-rc.2`）：

| 事项 | 证据 |
|---|---|
| 挂接缝是 `agent/turn-stopping` | `@deepseek-ai/dsh-agent-loop/lib/index.js:997-1005`：`if (turnEnds && this.inbox.nextStep.length === 0) await this.dispatch.serial("agent/turn-stopping", { turn, signal })` —— 只在**模型不再要工具、队列已排空**时触发，每轮至多一次 |
| 根 ctx 的监听器收得到 | `@deepseek-ai/dsh-scope/lib/index.js:327-335`：`const tag = scopeOf(ctx); if (tag === void 0) return true`（未打标签的监听器全局放行）；并已用探针在真实宿主里实测收到 |
| 事件签名与 mode | `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` 的 `EVENT_API`（81 条）：`'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent, turn, signal })`，`mode: serial` |
| 官方插件在同一缝上工作 | `@deepseek-ai/dsh-hooks-claude-code/lib/index.js:292-308`：Claude Code 的 `Stop` 钩子就是 `ctx.on("agent/turn-stopping", …)` |
| 子代理判别字段 | 创建 child agent 时写入 `AgentOptions.subagentDepth`；根会话不带该字段（实测 `subagentDepth=undefined`） |
| `ctx.on` 的未知事件会静默失效 | `@deepseek-ai/cordis/lib/index.js:371-380`：`_hooks[name] ||= []` 是开放 Map，无白名单 —— 事件名必须拿当前宿主的 `EVENT_API` 对过 |
| 宿主进程是正常完整性 | 实测 Electron 主进程与 `dsh-desktop-host` 均为 **Medium（S-1-16-8192）**；Low（S-1-16-4096）只用于被沙箱的 agent 命令与 Chromium 子进程。`dsh-plugin-manager/README.md:31`：installed Host code executes in-process outside the workspace sandbox |
| 为什么不用系统 SAPI | 沙箱侧实测 SAPI 音频端点被拒（中文 `0x80045040`、英文 `0x80070005`），而 `.NET SoundPlayer`（winmm）可用，因此只走纯文件播放 |
| 为什么不做浏览器半侧 | 宿主直接放音不需要 client bundle、不需要构建工具，也不受浏览器自动播放策略影响 |
| 更严谨的替代接缝 | `session/event` + `turn/end` + `reason.kind === 'completed'`（官方 practices 推荐）；实测该事件紧随 `turn-stopping` 到达，`reason=completed` 可区分成功/失败/中断 |

---

## 诚实的边界

- **只支持 Windows**：放音依赖 PowerShell + `System.Media.SoundPlayer`。其他平台会挂载但只记一条 warn，不响。
- **`agent/turn-stopping` 是 serial 且可被否决**：若环境里还挂着会让 agent「继续跑」的 `Stop` 钩子，
  本插件可能在一轮将续跑时先响一声。要更严谨可改挂 `session/event` + `turn/end`（见上表）。
- **同一进程内运行**：宿主插件与 DSH 同进程（已把所有异常吞掉，但仍属同进程代码）。
- **落地副本会累积**：每次安装/热更新产生一份 `deploy-<ts>`（约 0.6MB）。
  定期清理：`install.ps1 -Uninstall -Purge`，或手工删 `$DSH_HOME\plugins\voice-notify` 下的旧目录。
- **热更新的包名会带时间戳**：`-Hot` 挂载的包名形如 `dsh-voice-notify-live-<ts>`，
  在守护面板里就是这个名（同一个 `id` 始终只有一个条目，不会重复挂载、不会响两声）。

---

## 许可证

[MIT](LICENSE) © 2026 tang_au

语音音频由 edge-tts（微软晓晓）合成，随仓库一并分发；如用于再分发请自行确认合规。