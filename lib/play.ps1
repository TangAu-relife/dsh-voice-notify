<#
    dsh-voice-notify —— 宿主侧放音小工具
    ---------------------------------------------------------------
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File play.ps1 -Path <wav 绝对路径> [-LogPath <日志绝对路径>]

    为什么用 PowerShell + SoundPlayer：
      · DSH 宿主进程里不引第三方音频依赖，winmm 通路是最省事且实测可用的；
      · 绝不用系统 SAPI（本机沙箱下被拒），只做纯文件播放。

    为什么日志路径要由调用方传进来：
      宿主进程（Electron 起的 dsh-desktop-host）里 **`$env:DSH_HOME` 实测是 undefined**，
      只靠它会把日志默默写到 %TEMP%。插件在 node 侧用 os.homedir() 兜底算出绝对路径，
      通过 -LogPath 明确传进来，避免"以为有日志、其实在别处"。

    设计原则：**永不抛错**。放音失败不该影响任何任务收尾，静默退出即可，
    所以任何异常都吞掉，且始终以退出码 0 结束。
    每次尝试都追加一行到播报日志，作为「插件真的触发了」的落盘证据。
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$LogPath = ''
)

$logFile = if ($LogPath) {
    $LogPath
}
elseif ($env:DSH_HOME) {
    Join-Path $env:DSH_HOME 'voice-notify.log'
}
else {
    Join-Path $env:TEMP 'voice-notify.log'
}

function Write-Log([string]$Message) {
    try {
        $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
    }
    catch { }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Log "MISS  文件不存在: $Path"
        exit 0
    }
    $player = New-Object System.Media.SoundPlayer($Path)
    $player.PlaySync()
    $sw.Stop()
    Write-Log ('PLAY  {0}  {1:N2}s  {2}' -f (Split-Path $Path -Leaf), $sw.Elapsed.TotalSeconds, $Path)
}
catch {
    Write-Log "FAIL  $Path  错误: $($_.Exception.Message)"
}

exit 0