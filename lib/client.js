/**
 * dsh-voice-notify — 浏览器半侧（client half）
 *
 * 在 **设置页里单开一栏**（`settings.section` 插槽），把插件的配置做成表单：
 * 总开关 / 子代理轮次 / 最小间隔 / 固定语音（带句子原文）/ 额外语音目录 /
 * 放音脚本，外加「试听」与「播报日志尾部」——改完立即生效，不用重启 DSH。
 *
 * ── 这个文件为什么是这个形状（都有据可查）──────────────────────────────
 *   · 客户端模块是 `window.__ModuleLoader__.load({ id, factory })` 的**普通 JS**，
 *     不用任何构建工具；React 从浏览器的模块表 `require('react')` 拿
 *     （官方模板 `templates/decoration/client.js` 就是这个形状）。
 *   · `id` **必须精确等于包名**：宿主 dsh-client-modules 会硬校验
 *     "loaded without registering "<id>" via __ModuleLoader__.load"。
 *     本插件热更新时会换包名，所以 install.ps1 会把下面那行 id 一起改写
 *     （标记 `// __PKG_ID__`）。
 *   · 挂载方式：`dsh.client` 声明 + `exports["./client"]`；宿主扫描的是
 *     **Loader 的活条目**（不是 profile 名册），所以守护热挂载也照样能被发现。
 *   · `settings.section` 是设置页的"一栏一个页面"插槽（kind: list），
 *     注册项 `{ id, order, label }`，owner props 给你 `close()`。
 *     每个栏目自己画内部结构：文案、当前值、写回路径都由栏目负责。
 *   · 服务访问：返回对象里的 `inject: ['slots']` 是 cordis 的 fiber 注入；
 *     locale 服务在客户端不一定存在，所以只做"有就用、没有就用中文兜底"。
 */

/** 本插件的 locale 命名空间（稳定，不随包名变）。 */
const NS = 'voice-notify'

/** 栏目文案：zh 为兜底，en 供英文界面。 */
const TEXT = {
  zh: {
    nav: '语音提醒',
    title: '语音提醒',
    intro: '一轮对话真正收尾时，随机播报一句中文语音提醒。设置改完立即生效，不需要重启。',
    enabled: '启用提醒',
    includeSubagents: '子代理轮次也提醒',
    minInterval: '最小间隔',
    minIntervalUnit: '毫秒',
    minIntervalHint: '这个间隔内的多条提醒只响一次（吸收同时收尾的多个轮次）',
    clip: '固定语音',
    clipRandom: '随机（每次从池里挑一条）',
    clipDir: '额外语音目录',
    clipDirHint: '把这个目录里的 *.wav 一起加入随机池，留空＝只用内置语音',
    chipsHint: '点一下＝固定这条语音，双击＝立刻试听；点「随机」＝每轮从池里随机挑',
    advanced: '高级',
    voiceScript: '放音脚本',
    voiceScriptHint: '留空＝用包内 lib/play.ps1（PowerShell + .NET SoundPlayer）',
    save: '保存',
    test: '试听',
    testing: '正在试听…',
    saved: '已保存 ✔',
    saveFailed: '保存失败',
    loadFailed: '读取配置失败',
    testFailed: '试听失败',
    logs: '播报日志（最近 30 行）',
    refresh: '刷新',
    empty: '（还没有记录：下一轮对话收尾时就会写进来）',
    configPath: '配置文件',
    logPath: '播报日志',
  },
  en: {
    nav: 'Voice notify',
    title: 'Voice notify',
    intro: 'Plays a short Chinese voice clip when a turn actually finishes. Changes apply immediately.',
    enabled: 'Enable notification',
    includeSubagents: 'Also notify for subagent turns',
    minInterval: 'Minimum interval',
    minIntervalUnit: 'ms',
    minIntervalHint: 'Turns finishing within this window announce only once',
    clip: 'Pinned clip',
    clipRandom: 'Random (pick one per turn)',
    clipDir: 'Extra clip directory',
    clipDirHint: '*.wav in this directory joins the random pool; empty = built-in clips only',
    chipsHint: 'Click to pin a clip, double-click to preview; Random picks one each turn',
    advanced: 'Advanced',
    voiceScript: 'Player script',
    voiceScriptHint: 'Empty = bundled lib/play.ps1 (PowerShell + .NET SoundPlayer)',
    save: 'Save',
    test: 'Preview',
    testing: 'Previewing…',
    saved: 'Saved ✔',
    saveFailed: 'Save failed',
    loadFailed: 'Failed to read config',
    testFailed: 'Preview failed',
    logs: 'Announcement log (last 30 lines)',
    refresh: 'Refresh',
    empty: '(no records yet — the next finished turn writes one)',
    configPath: 'Config file',
    logPath: 'Log file',
  },
}

/** 同源接口封装：非 2xx 一律抛错，把宿主给的 error 文案带出来。 */
async function api(path, options) {
  const response = await fetch(path, options)
  const text = await response.text()
  let parsed = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch (error) {
    parsed = null
  }
  if (!response.ok) throw new Error((parsed && parsed.error) || `HTTP ${response.status}`)
  return parsed
}

window.__ModuleLoader__.load({
  // ⚠️ 必须等于挂载用的包名；install.ps1 在热更新部署时改这一行。
  id: 'dsh-voice-notify', // __PKG_ID__
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      wrap: { padding: '16px 18px 28px', width: '100%', maxWidth: '100%', boxSizing: 'border-box', color: 'inherit', fontSize: '13px', lineHeight: 1.6 },
      h1: { margin: '0 0 6px', fontSize: '16px', fontWeight: 600 },
      intro: { margin: '0 0 18px', opacity: 0.7 },
      group: { display: 'flex', flexDirection: 'column', gap: '14px' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      check: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
      label: { fontWeight: 500 },
      hint: { opacity: 0.6, fontSize: '12px' },
      input: {
        font: 'inherit', color: 'inherit', padding: '5px 8px', borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.45)', background: 'rgba(128,128,128,0.08)', width: '100%',
        boxSizing: 'border-box',
      },
      select: {
        font: 'inherit', color: 'inherit', padding: '5px 8px', borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.45)', background: 'rgba(128,128,128,0.08)',
        flex: '1 1 auto', minWidth: 0, boxSizing: 'border-box', colorScheme: 'light',
      },
      option: { color: '#111827', background: '#ffffff' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' },
      chip: {
        font: 'inherit', fontSize: '12px', color: 'inherit', cursor: 'pointer', padding: '3px 9px',
        borderRadius: '999px', border: '1px solid rgba(128,128,128,0.45)', background: 'rgba(128,128,128,0.10)',
      },
      chipActive: {
        font: 'inherit', fontSize: '12px', color: 'inherit', cursor: 'pointer', padding: '3px 9px',
        borderRadius: '999px', border: '1px solid rgba(64,132,224,0.95)', background: 'rgba(64,132,224,0.22)',
      },
      number: {
        font: 'inherit', color: 'inherit', padding: '5px 8px', borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.45)', background: 'rgba(128,128,128,0.08)', width: '110px',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px', flexWrap: 'wrap' },
      button: {
        font: 'inherit', color: 'inherit', cursor: 'pointer', padding: '6px 14px', borderRadius: '7px',
        border: '1px solid rgba(128,128,128,0.5)', background: 'rgba(128,128,128,0.14)',
      },
      buttonPrimary: {
        font: 'inherit', color: '#fff', cursor: 'pointer', padding: '6px 16px', borderRadius: '7px',
        border: '1px solid rgba(64,132,224,0.9)', background: 'rgb(64,132,224)',
      },
      note: { opacity: 0.75, fontSize: '12px' },
      logs: {
        marginTop: '8px', maxWidth: '100%', boxSizing: 'border-box', maxHeight: '190px', overflow: 'auto', padding: '8px 10px', borderRadius: '7px',
        border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.08)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
      },
      footer: { marginTop: '20px', opacity: 0.55, fontSize: '11.5px', wordBreak: 'break-all' },
      divider: { marginTop: '20px', borderTop: '1px solid rgba(128,128,128,0.28)', paddingTop: '14px' },
    }

    function Section(props) {
      const t = props.t
      const [cfg, setCfg] = React.useState(null)
      const [meta, setMeta] = React.useState({ clips: [], configPath: '', logPath: '', platform: '' })
      const [logs, setLogs] = React.useState([])
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [advanced, setAdvanced] = React.useState(false)

      const refreshLogs = React.useCallback(async () => {
        try {
          const data = await api('/voice-notify/log?lines=30')
          setLogs(Array.isArray(data && data.lines) ? data.lines : [])
        } catch (error) {
          setLogs([])
        }
      }, [])

      const load = React.useCallback(async () => {
        try {
          const data = await api('/voice-notify/config')
          setCfg(data.config)
          setMeta({
            clips: Array.isArray(data.clips) ? data.clips : [],
            configPath: data.configPath || '',
            logPath: data.logPath || '',
            platform: data.platform || '',
          })
          setNote('')
        } catch (error) {
          setNote(`${t('loadFailed')}: ${String(error.message || error)}`)
        }
      }, [])

      React.useEffect(() => {
        load()
        refreshLogs()
      }, [load, refreshLogs])

      const patch = (key, value) => setCfg((current) => ({ ...current, [key]: value }))

      const save = async () => {
        setBusy(true)
        try {
          const body = {
            enabled: cfg.enabled,
            includeSubagents: cfg.includeSubagents,
            minIntervalMs: Number(cfg.minIntervalMs),
            clip: cfg.clip,
            clipDir: cfg.clipDir,
            voiceScript: cfg.voiceScript,
          }
          const data = await api('/voice-notify/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          setCfg(data.config)
          setNote(t('saved'))
          refreshLogs()
        } catch (error) {
          setNote(`${t('saveFailed')}: ${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }

      const preview = async (clip) => {
        setBusy(true)
        setNote(t('testing'))
        try {
          const data = await api('/voice-notify/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clip ? { clip } : {}),
          })
          setNote(data && data.ok ? `${t('test')} ✔ ${data.text || data.file || ''}` : `${t('testFailed')}`)
          window.setTimeout(refreshLogs, 1200)
        } catch (error) {
          setNote(`${t('testFailed')}: ${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }

      if (cfg === null) {
        return h('div', { style: styles.wrap }, h('h1', { style: styles.h1 }, t('title')), h('div', { style: styles.intro }, note || '…'))
      }

      const clipOptions = [{ id: '', text: t('clipRandom') }].concat(meta.clips.map((clip) => ({ id: clip.id, text: `${clip.id}　${clip.text}` })))

      return h(
        'div',
        { style: styles.wrap },
        h('h1', { style: styles.h1 }, t('title')),
        h('div', { style: styles.intro }, t('intro')),

        h(
          'div',
          { style: styles.group },
          h(
            'label',
            { style: styles.check },
            h('input', { type: 'checkbox', checked: cfg.enabled === true, onChange: (event) => patch('enabled', event.target.checked) }),
            h('span', { style: styles.label }, t('enabled')),
          ),
          h(
            'label',
            { style: styles.check },
            h('input', { type: 'checkbox', checked: cfg.includeSubagents === true, onChange: (event) => patch('includeSubagents', event.target.checked) }),
            h('span', { style: styles.label }, t('includeSubagents')),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('minInterval')),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' } },
              h('input', {
                type: 'number', min: 0, max: 600000, step: 500, value: String(cfg.minIntervalMs),
                style: styles.number, onChange: (event) => patch('minIntervalMs', event.target.value),
              }),
              h('span', { style: styles.hint }, t('minIntervalUnit')),
            ),
            h('span', { style: styles.hint }, t('minIntervalHint')),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('clip')),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' } },
              h(
                'select',
                { value: cfg.clip || '', style: styles.select, onChange: (event) => patch('clip', event.target.value) },
                clipOptions.map((option) => h('option', { key: option.id || 'random', value: option.id, style: styles.option }, option.text)),
              ),
              h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => preview(cfg.clip || '') }, t('test')),
              h(
                'div',
                { style: { ...styles.chips, flexBasis: '100%' } },
                clipOptions.map((option) => h(
                  'button',
                  {
                    key: option.id || 'random',
                    type: 'button',
                    title: option.text,
                    style: (cfg.clip || '') === (option.id || '') ? styles.chipActive : styles.chip,
                    onClick: () => patch('clip', option.id),
                    onDoubleClick: () => preview(option.id),
                  },
                  option.text,
                )),
              ),
              h('span', { style: { ...styles.hint, flexBasis: '100%' } }, t('chipsHint')),
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('clipDir')),
            h('input', { type: 'text', value: cfg.clipDir || '', style: styles.input, onChange: (event) => patch('clipDir', event.target.value) }),
            h('span', { style: styles.hint }, t('clipDirHint')),
          ),
          h(
            'div',
            { style: styles.row },
            h('label', { style: styles.check }, h('input', { type: 'checkbox', checked: advanced, onChange: (event) => setAdvanced(event.target.checked) }), h('span', { style: styles.label }, t('advanced'))),
            advanced
              ? h(
                'div',
                { style: styles.row },
                h('span', { style: styles.label }, t('voiceScript')),
                h('input', { type: 'text', value: cfg.voiceScript || '', style: styles.input, onChange: (event) => patch('voiceScript', event.target.value) }),
                h('span', { style: styles.hint }, t('voiceScriptHint')),
              )
              : null,
          ),
        ),

        h(
          'div',
          { style: styles.actions },
          h('button', { type: 'button', style: styles.buttonPrimary, disabled: busy, onClick: save }, t('save')),
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => preview('') }, t('test')),
          note ? h('span', { style: styles.note }, note) : null,
        ),

        h(
          'div',
          { style: styles.divider },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
            h('span', { style: styles.label }, t('logs')),
            h('button', { type: 'button', style: styles.button, onClick: refreshLogs }, t('refresh')),
          ),
          h('div', { style: styles.logs }, logs.length > 0 ? logs.join('\n') : t('empty')),
        ),

        h(
          'div',
          { style: styles.footer },
          h('div', null, `${t('configPath')}: ${meta.configPath}`),
          h('div', null, `${t('logPath')}: ${meta.logPath}`),
          meta.platform && meta.platform !== 'win32' ? h('div', null, `platform: ${meta.platform} (no audio backend)`) : null,
        ),
      )
    }

    return {
      /** cordis fiber 注入：只用插槽服务（locale 有则用、无则中文兜底）。 */
      inject: ['slots'],
      apply(ctx) {
        let t = (key) => (TEXT.zh[key] !== undefined ? TEXT.zh[key] : key)
        try {
          if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, TEXT)
            if (typeof ctx.locale.bind === 'function') t = ctx.locale.bind(NS)
          }
        } catch (error) {
          // 没有 locale 服务：中文兜底，不影响功能。
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          {
            name: 'settings.section',
            id: 'voice-notify',
            order: 40,
            label: () => t('nav'),
          },
          (ownerProps) => h(Section, { ...ownerProps, t }),
        ))
      },
    }
  },
})