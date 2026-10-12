/**
 * dsh-voice-notify — 宿主半侧（server half）
 *
 * 一轮对话**真正结束**时，用中文语音播报一句提醒（随包内置 20 条叠词语音）。
 *
 * ── 挂接缝（有据可查，非猜测）─────────────────────────────────────────────
 *   agent/turn-stopping
 *     由 agent loop 串行派发，位置在「本可完成的轮次关闭前」：
 *       if (turnEnds && this.inbox.nextStep.length === 0)
 *         await this.dispatch.serial("agent/turn-stopping", { turn, signal })
 *     即**模型不再要求工具调用、且没有排队步骤**时才触发，每轮至多一次。
 *     声明签名（宿主生成区）：
 *       'agent/turn-stopping'(this: Scoped<Agent>,
 *         payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
 *     官方 dsh-hooks-claude-code 桥的 Stop 钩子就挂在同一个缝上。
 *
 * ── 放音方式 ─────────────────────────────────────────────────────────────
 *   PowerShell + .NET SoundPlayer（winmm 通路），不引第三方音频依赖。
 *   绝不用系统 SAPI：本机沙箱下 SAPI 音频端点被拒（0x80045040 / 0x80070005），
 *   而 SoundPlayer 实测可用。
 *
 * ── 两条实测踩过的坑（别再踩）────────────────────────────────────────────
 *   1. **不要用 `detached: true` 去 spawn powershell.exe**
 *      宿主里实测（三种配置对照）：detached + stdio:'ignore' 时子进程虽然
 *      以退出码 0 结束（存活 74~393ms），但 **命令完全没执行**（marker 文件不生成）；
 *      去掉 detached（保持 stdio:'ignore' + windowsHide + unref）后正常执行。
 *      detached 在 Windows 上是 DETACHED_PROCESS：无控制台的 powershell.exe
 *      在这条路径下不干活。要"不阻塞"用 unref() 就够了，不需要 detached。
 *   2. **宿主进程里 `$env:DSH_HOME` 是 undefined**（Electron 起的 dsh-desktop-host
 *      没这个变量），只靠它 play.ps1 会把日志写进 %TEMP%。
 *      所以这里在 node 侧算出绝对日志路径，用 -LogPath 明确传给脚本。
 *
 * ── 设计原则 ─────────────────────────────────────────────────────────────
 *   1. **绝不阻塞轮次**：spawn 后 unref，立刻返回，不等放完。
 *   2. **永不抛错**：任何异常都吞掉、只记日志——提醒插件绝不能影响任务收尾。
 *   3. **不吵**：默认忽略子代理轮次（AgentOptions.subagentDepth > 0），
 *      并有最小间隔去重（多个轮次同时收尾时不叠加）。
 *   4. **可自证**：从 apply / 收到事件 / 跳过原因 / spawn 到 PowerShell 的真实播放，
 *      每一步都往同一个日志文件写一行，出问题能立刻定位在哪一段断掉。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-voice-notify'

/**
 * 顶层**不声明** inject。
 *
 * cordis 解析顶层 `inject` 时若插件 ctx 已 inactive，会抛
 * `cannot get required service "..." in inactive context` 并让整个进程启动失败，
 * 且该错误发生在 apply **之前**，apply 内的 try/catch 拦不住
 * （dsh-my-guardian 的实测记录）。本插件只注册一个事件监听、不消费任何服务，
 * 因此空数组最安全。
 */
export const inject = []

/** 包根：lib/index.js → 包根。保持可重定位（node_modules 或本地 link 都能跑）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILTIN_DIR = path.join(PACKAGE_ROOT, 'assets')
const PLAY_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'play.ps1')

/**
 * 播报日志的绝对路径。
 * 宿主里 DSH_HOME 实测为 undefined，所以用 os.homedir()/.dsh 兜底
 * ——这与 DSH 在本机的实际 home 一致，且不依赖宿主的环境变量。
 */
const HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOG_PATH = path.join(HOME_DIR, 'voice-notify.log')

/**
 * 设置页写入的配置落盘位置。
 * 优先级：**这个文件 > 挂载条目的 config > 默认值** —— 设置页是权威的，
 * 部署方仍能在 patch 里给一份初始配置。写文件即热生效，不需要重启宿主。
 */
const CONFIG_PATH = path.join(HOME_DIR, 'plugins', 'voice-notify', 'config.json')

/** 设置页允许写入的字段范围（毫秒）。 */
const MIN_INTERVAL_RANGE = { min: 0, max: 600000 }

/** 随包内置语音：晓晓（zh-CN-XiaoxiaoNeural，温暖）朗读的叠词短句。 */
export const CLIPS = [
  { id: 'done-1', file: 'done-1.wav', text: '主人主人，任务完成啦～' },
  { id: 'done-2', file: 'done-2.wav', text: '都弄好啦，快来看看嘛～' },
  { id: 'done-3', file: 'done-3.wav', text: '事情办得妥妥的，夸夸我嘛～' },
  { id: 'done-4', file: 'done-4.wav', text: '报告报告，全部搞定啦～' },
  { id: 'done-5', file: 'done-5.wav', text: '主人主人，我棒不棒呀～' },
  { id: 'done-6', file: 'done-6.wav', text: '好啦好啦，全都做完啦～' },
  { id: 'done-7', file: 'done-7.wav', text: '快夸夸我呀，我可厉害啦～' },
  { id: 'done-8', file: 'done-8.wav', text: '叮咚，任务完成，撒花撒花～' },
  { id: 'done-9', file: 'done-9.wav', text: '主人主人，辛苦你啦，也夸夸我嘛～' },
  { id: 'done-10', file: 'done-10.wav', text: '收工收工，要不要歇一歇呀～' },
  { id: 'done-11', file: 'done-11.wav', text: '办完啦办完啦，快来看看嘛～' },
  { id: 'done-12', file: 'done-12.wav', text: '才不是特意为你做的呢，快收下～' },
  { id: 'done-13', file: 'done-13.wav', text: '别太感动哦，我只是顺手做的～' },
  { id: 'done-14', file: 'done-14.wav', text: '搞定啦搞定啦，主人要不要抱抱～' },
  { id: 'done-15', file: 'done-15.wav', text: '忙完啦，主人记得喝水水哦～' },
  { id: 'done-16', file: 'done-16.wav', text: '叮铃铃，任务交卷啦～' },
  { id: 'done-17', file: 'done-17.wav', text: '夸夸我夸夸我，不然我要闹啦～' },
  { id: 'done-18', file: 'done-18.wav', text: '圆满完成，给我一点掌声嘛～' },
  { id: 'done-19', file: 'done-19.wav', text: '主人主人，累不累呀，歇一会儿嘛～' },
  { id: 'done-20', file: 'done-20.wav', text: '做完啦，主人快摸摸我的头～' },
]

/** 配置默认值；profile 的 patch 里给 config 就覆盖它。 */
const DEFAULTS = {
  /** 总开关。false 时插件挂载但完全不响。 */
  enabled: true,
  /** 子代理轮次是否也响。默认 false —— 否则每个子代理收尾都会响，很吵。 */
  includeSubagents: false,
  /** 两条提醒的最小间隔（毫秒），用于吸收同时收尾的多个轮次。 */
  minIntervalMs: 4000,
  /** 固定某一条内置语音（如 'done-3'）；留空＝随机。 */
  clip: '',
  /** 额外语音目录：把自定义 *.wav 丢进去就一起进随机池（可选）。 */
  clipDir: '',
  /** 覆盖放音脚本路径（默认包内 lib/play.ps1）。 */
  voiceScript: '',
}

/** 把任意 config 收敛成可信选项：类型不对就用默认值，绝不因配置崩掉。 */
function normalize(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const str = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    includeSubagents: bool(raw.includeSubagents, DEFAULTS.includeSubagents),
    minIntervalMs: num(raw.minIntervalMs, DEFAULTS.minIntervalMs),
    clip: str(raw.clip, DEFAULTS.clip),
    clipDir: str(raw.clipDir, DEFAULTS.clipDir),
    voiceScript: str(raw.voiceScript, DEFAULTS.voiceScript),
  }
}

/**
 * 面包屑：把「插件走到了哪一步」写进同一个播报日志。
 * 宿主日志通道（ctx.logger）在桌面端不一定能看到，落盘才是可查的证据。
 * 绝不抛错。
 */
function breadcrumb(config, message) {
  try {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    // 与 play.ps1 的时间格式保持一致（本地时间、秒级），方便两段证据对着看。
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    appendFileSync(LOG_PATH, `${stamp}  [plugin] ${message}\r\n`)
  } catch (error) {
    // 日志写不下去也不能影响任何事。
  }
}

/** 子代理轮次判别：宿主在创建 child agent 时写入 AgentOptions.subagentDepth。 */
function isSubagent(agent) {
  const depth = agent?.options?.subagentDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 组装候选语音池：内置的 20 条，外加（可选）用户目录里的 *.wav。
 * 用户目录每次都重扫，这样新丢进去的文件立刻可用，无需重启。
 */
function collectClips(options) {
  const pool = CLIPS.map((clip) => ({ text: clip.text, file: path.join(BUILTIN_DIR, clip.file) }))
  if (options.clipDir.length > 0) {
    try {
      const extra = readdirSync(options.clipDir)
        .filter((entry) => entry.toLowerCase().endsWith('.wav'))
        .sort()
        .map((entry) => ({ text: entry, file: path.join(options.clipDir, entry) }))
      pool.push(...extra)
    } catch (error) {
      // 目录不存在/无权限都不算错误：只用内置语音即可。
    }
  }
  if (options.clip.length > 0) {
    const pinned = CLIPS.find((clip) => clip.id === options.clip)
    if (pinned !== undefined) return [{ text: pinned.text, file: path.join(BUILTIN_DIR, pinned.file) }]
  }
  return pool
}

/**
 * 放一条语音：spawn 后 unref，立刻返回，不等它放完。
 *
 * ⚠️ 这里**刻意不加 `detached: true`**：Windows 上 detached 即 DETACHED_PROCESS，
 * 无控制台的 powershell.exe 在这条路径下会"退出码 0 但什么都没做"（实测）。
 * 不阻塞轮次靠 `unref()` 就够了。
 */
function play(script, wav, breadcrumbFn) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', wav, '-LogPath', LOG_PATH],
    { stdio: 'ignore', windowsHide: true },
  )
  breadcrumbFn(`spawn 放音进程 pid=${child.pid}  →  ${path.basename(wav)}`)
  child.on('error', (error) => breadcrumbFn(`spawn 失败: ${String(error)}`))
  child.on('exit', (code, signal) => breadcrumbFn(`放音进程退出 code=${code} signal=${signal}`))
  child.unref()
}

/** 读设置页落盘的配置。读不到 / 坏了都当作"没有配置"。 */
function readConfigFile() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 写设置页配置。失败只记日志（不抛），设置页会收到错误响应。 */
function writeConfigFile(value) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 把设置页发来的补丁收敛成可信配置：**逐字段白名单 + 类型校验 + 范围夹取**。
 * 未知字段直接丢弃，绝不把任意 JSON 写进配置。
 */
function sanitizePatch(current, patch) {
  const next = { ...current }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (typeof patch.includeSubagents === 'boolean') next.includeSubagents = patch.includeSubagents
  if (typeof patch.minIntervalMs === 'number' && Number.isFinite(patch.minIntervalMs)) {
    next.minIntervalMs = Math.min(Math.max(Math.round(patch.minIntervalMs), MIN_INTERVAL_RANGE.min), MIN_INTERVAL_RANGE.max)
  }
  // 固定语音只接受内置 id；给别的值＝回到随机。
  if (typeof patch.clip === 'string') next.clip = CLIPS.some((clip) => clip.id === patch.clip) ? patch.clip : ''
  if (typeof patch.clipDir === 'string') next.clipDir = patch.clipDir.trim()
  if (typeof patch.voiceScript === 'string') next.voiceScript = patch.voiceScript.trim()
  return next
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, value) {
  try {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(value))
  } catch (error) {
    // 连接已断：忽略。
  }
}

/** 收集请求体（上限 64KB），无论成败都以字符串回调一次。 */
function collectBody(req, callback) {
  const chunks = []
  let size = 0
  let done = false
  req.on('data', (chunk) => {
    if (done) return
    size += chunk.length
    if (size > 64 * 1024) { done = true; callback(''); return }
    chunks.push(chunk)
  })
  req.on('end', () => { if (!done) { done = true; callback(Buffer.concat(chunks).toString('utf8')) } })
  req.on('error', () => { if (!done) { done = true; callback('') } })
}

/**
 * 浏览器半侧（设置页那一栏）用的三个同源接口。
 * 走宿主 webserver 服务 `ctx.webServer`（wallpaper-engine 同款契约：
 * `register({ kind:'exact', path, handler(req,res) })` 返回 disposer）。
 *
 * 用 `ctx.inject(['webServer'], cb)` 局部等这个服务，**不在顶层声明 inject**
 * ——顶层 inject 在 inactive ctx 上会 fatal 且发生在 apply 之前。
 */
function registerRoutes(ctx, state, io) {
  const mount = (server) => {
    if (server === undefined || server === null) {
      io.warn('webServer 服务不可用：设置页读不到配置（其余功能不受影响）。')
      return
    }
    const disposers = []
    const on = (routePath, handler) => {
      try {
        const dispose = server.register({ kind: 'exact', path: routePath, handler })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        io.warn(`注册路由 ${routePath} 失败（已忽略）: ${String(error)}`)
      }
    }

    // 读配置 / 写配置
    on('/voice-notify/config', (req, res) => {
      const method = (req.method || '').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          config: state.options,
          defaults: DEFAULTS,
          clips: CLIPS.map((clip) => ({ id: clip.id, text: clip.text })),
          configPath: CONFIG_PATH,
          logPath: LOG_PATH,
          platform: process.platform,
        })
        return
      }
      if (method !== 'POST') { res.statusCode = 405; res.end(); return }
      collectBody(req, (raw) => {
        try {
          const parsed = raw.length > 0 ? JSON.parse(raw) : {}
          const next = sanitizePatch(state.options, parsed !== null && typeof parsed === 'object' ? parsed : {})
          writeConfigFile(next)
          state.options = next
          io.log(`设置页更新配置：enabled=${next.enabled} 子代理=${next.includeSubagents} 间隔=${next.minIntervalMs}ms 语音=${next.clip.length > 0 ? next.clip : '随机'}`)
          sendJson(res, 200, { ok: true, config: next })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) })
        }
      })
    })

    // 试听：显式动作，**不受 enabled 影响**（关着也能试听）
    on('/voice-notify/test', (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return }
      collectBody(req, (raw) => {
        try {
          let wanted = ''
          if (raw.length > 0) {
            const parsed = JSON.parse(raw)
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.clip === 'string') wanted = parsed.clip
          }
          const pinned = CLIPS.find((clip) => clip.id === wanted)
          const options = pinned !== undefined ? { ...state.options, clip: pinned.id } : state.options
          const pool = collectClips(options)
          if (pool.length === 0) { sendJson(res, 200, { ok: false, error: '候选语音池为空' }); return }
          const picked = pool[Math.floor(Math.random() * pool.length)]
          const script = state.options.voiceScript.length > 0 ? state.options.voiceScript : PLAY_SCRIPT
          play(script, picked.file, io.say)
          sendJson(res, 200, { ok: true, file: path.basename(picked.file), text: picked.text })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) })
        }
      })
    })

    // 播报日志尾部（设置页里直接看硬证据，不用去翻文件）
    on('/voice-notify/log', (req, res) => {
      try {
        const url = new URL(req.url || '/voice-notify/log', 'http://localhost')
        const parsed = Number.parseInt(url.searchParams.get('lines') || '40', 10)
        const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 40
        let lines = []
        try {
          lines = readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).filter((line) => line.length > 0).slice(-limit)
        } catch (error) {
          lines = []
        }
        sendJson(res, 200, { ok: true, logPath: LOG_PATH, lines })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    })

    io.log(`设置页接口已注册：/voice-notify/config、/voice-notify/test、/voice-notify/log`)
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch (error) { /* 卸载期忽略 */ }
      }
    }
  }

  try {
    ctx.inject(['webServer'], (scoped) => mount(scoped.webServer))
  } catch (error) {
    io.warn(`等待 webServer 服务失败（已忽略）: ${String(error)}`)
  }
}

export function apply(ctx, config) {
  // 设置页（文件）覆盖挂载条目的 config，再落到默认值。
  const state = {
    options: normalize({ ...(config !== null && typeof config === 'object' ? config : {}), ...readConfigFile() }),
  }
  const say = (message) => breadcrumb(state.options, message)
  const logger = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-voice-notify: ${message}`)
    } catch (error) {
      // 日志通道本身不可用时也不能影响任何东西。
    }
  }
  const log = (message) => {
    say(message)
    logger('info', message)
  }
  const warn = (message) => {
    say(message)
    logger('warn', message)
  }

  // 1) 先挂设置页接口：即使本平台放不了音，那一栏也要能打开并说明原因。
  registerRoutes(ctx, state, { say, log, warn })

  // 2) 平台闸门：放音依赖 Windows PowerShell。
  if (process.platform !== 'win32') {
    warn(`当前平台 ${process.platform} 不支持 PowerShell 放音：插件与设置页可用，但不会响。`)
  }

  // 3) 轮次收尾提醒。所有选项**每次现读** state.options —— 设置页改完立即生效。
  let lastPlayedAt = 0

  ctx.on('agent/turn-stopping', function (payload) {
    try {
      const options = state.options
      const agent = payload?.agent ?? this
      const depth = agent?.options?.subagentDepth
      say(`收到 agent/turn-stopping：turn=${payload?.turn} agentId=${agent?.id} subagentDepth=${depth}`)

      if (!options.enabled) {
        say('跳过：设置页里已关闭（enabled=false）')
        return
      }
      if (!options.includeSubagents && isSubagent(agent)) {
        say('跳过：子代理轮次（includeSubagents=false）')
        return
      }

      const now = Date.now()
      if (now - lastPlayedAt < options.minIntervalMs) {
        say(`跳过：距上次 ${now - lastPlayedAt}ms < minIntervalMs ${options.minIntervalMs}ms`)
        return
      }

      const pool = collectClips(options)
      if (pool.length === 0) {
        say('跳过：候选语音池为空')
        return
      }
      const picked = pool[Math.floor(Math.random() * pool.length)]

      lastPlayedAt = now
      const script = options.voiceScript.length > 0 ? options.voiceScript : PLAY_SCRIPT
      play(script, picked.file, say)
    } catch (error) {
      warn(`提醒失败（已忽略）: ${String(error)}`)
    }
  })

  log(`已挂载：监听 agent/turn-stopping，enabled=${state.options.enabled}，候选语音 ${collectClips(state.options).length} 条，最小间隔 ${state.options.minIntervalMs}ms，配置 ${CONFIG_PATH}，日志 ${LOG_PATH}`)
}