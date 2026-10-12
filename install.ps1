<#
    dsh-voice-notify —— 安装 / 卸载脚本
    ===============================================================
    用法（在插件目录里跑）：

      powershell -ExecutionPolicy Bypass -File .\install.ps1              # 装到 desktop（守护热挂载）
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Hot         # 改代码后不重启也生效
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web # 指定 profile
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode roster # 走正式名册（需重启）
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall   # 卸载（-Purge 连副本删）

    ── 为什么是"落地副本 + junction" ─────────────────────────────────────────
    宿主按**包名（说明符）**缓存已导入的 ESM 模块（dsh-app-boot 的 state.esm）。
    实测：同一个包名无论把 junction 重指到哪个新路径、重挂多少次，跑的都还是最初那份代码。

      · 普通安装（规范名 dsh-voice-notify）：改代码后需**重启 DSH** 才生效；
      · -Hot：把本次副本挂在一个**带时间戳的新包名**下，包名一变即全新导入，
        于是在**运行中的宿主里立即生效**（旧包名/旧副本会被清理）。

    两种模式都**不跑 pnpm**，只做 junction + 落地副本 + 配置写入，不动运行中的依赖树。

    ── 为什么优先走守护 HTTP 接口 ——————————————————————————————————————
    守护的热加载有两路：fs.watch(暂存文件) 与 4 秒轮询，两路都要 shared.ready。
    实测桌面端该标志可能为 false（两路一起空转），此时只写暂存文件不会挂载；
    而 POST /guardian/api/staged 会直接调用 scanStaged()，是可靠通道。
    所以本脚本优先走接口，不可达才退回写暂存文件（下次启动生效）。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',

    [ValidateSet('guardian', 'roster')]
    [string]$Mode = 'guardian',

    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),

    [int]$Port = 19387,

    [switch]$Hot,

    [switch]$Uninstall,

    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
$entryId = 'voice-notify'
$packageBase = 'dsh-voice-notify'
$apiBase = "http://127.0.0.1:$Port"

$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile 目录不存在: $profileDir" }
$profileDir = (Resolve-Path -LiteralPath $profileDir).Path
$modulesDir = Join-Path $profileDir 'node_modules'
$deployRoot = Join-Path $DshHome 'plugins\voice-notify'

"DSH_HOME : $DshHome"
"profile  : $Profile  ($profileDir)"
$modeLabel = if ($Uninstall) { '卸载' } elseif ($Hot) { "$Mode + 热更新" } else { $Mode }
"模式     : $modeLabel"
''

function Get-JsonFile([string]$Path, $Default) {
    if (-not (Test-Path -LiteralPath $Path)) { return $Default }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    return ($raw | ConvertFrom-Json)
}

function Save-JsonFile([string]$Path, $Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 12
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-GuardianApi([string]$Method, $Payload) {
    try {
        $headers = @{
            'Origin'         = $apiBase
            'Referer'        = "$apiBase/"
            'Sec-Fetch-Site' = 'same-origin'
            'Content-Type'   = 'application/json'
        }
        $body = ConvertTo-Json -InputObject $Payload -Compress
        $response = Invoke-WebRequest -Uri "$apiBase/guardian/api/$Method" -Method POST -Body $body -Headers $headers -TimeoutSec 20 -UseBasicParsing
        return ($response.Content | ConvertFrom-Json)
    }
    catch {
        $detail = $_.Exception.Message.Split([Environment]::NewLine)[0]
        Write-Host "  · guardian 接口 $Method 不可用（$detail）"
        return $null
    }
}

function Get-PluginLinks {
    if (-not (Test-Path -LiteralPath $modulesDir)) { return @() }
    return @(Get-ChildItem -LiteralPath $modulesDir -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$packageBase*" -and $_.LinkType })
}

function Remove-PluginLinks([string]$KeepName) {
    foreach ($item in Get-PluginLinks) {
        if ($item.Name -eq $KeepName) { continue }
        try {
            [System.IO.Directory]::Delete($item.FullName, $false)
            "  ✓ 已清理旧 junction: $($item.Name)"
        }
        catch { "  ! 清理失败（忽略）: $($item.Name)" }
    }
}

function Clear-StagedEntry {
    $stagedPath = Join-Path $profileDir 'cordis.staged.json'
    if (-not (Test-Path -LiteralPath $stagedPath)) { return }
    $list = @(Get-JsonFile $stagedPath @())
    $kept = @($list | Where-Object { $_.id -ne $entryId })
    if ($kept.Count -ne $list.Count) {
        Save-JsonFile $stagedPath $kept
        '  ✓ 已从 cordis.staged.json 移除条目'
    }
}

if ($Uninstall) {
    $viaApi = Invoke-GuardianApi 'remove' @{ id = $entryId }
    if ($viaApi) { '✓ 已通过守护接口移除条目（含运行中的挂载）' } else { Clear-StagedEntry }

    Remove-PluginLinks ''
    if ((Get-PluginLinks).Count -eq 0) { '（profile 里已无本插件 junction）' }

    $pkgPath = Join-Path $profileDir 'package.json'
    $pkg = Get-JsonFile $pkgPath $null
    if ($pkg) {
        $changed = $false
        if ($pkg.dependencies) {
            foreach ($name in @($pkg.dependencies.PSObject.Properties.Name)) {
                if ($name -like "$packageBase*") { $pkg.dependencies.PSObject.Properties.Remove($name); $changed = $true }
            }
        }
        if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
            $keptBundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -notlike "$packageBase*" })
            if ($keptBundles.Count -ne @($pkg.dsh.profile.bundles).Count) {
                $pkg.dsh.profile.bundles = $keptBundles
                $changed = $true
            }
        }
        if ($changed) { Save-JsonFile $pkgPath $pkg; '✓ 已从 profile package.json 移除依赖与 bundles 条目' }
    }

    if ($Purge -and (Test-Path -LiteralPath $deployRoot)) {
        Remove-Item -LiteralPath $deployRoot -Recurse -Force
        "✓ 已删除落地副本目录: $deployRoot"
    }
    elseif (Test-Path -LiteralPath $deployRoot) {
        "（落地副本保留在 $deployRoot，加 -Purge 可一并删除）"
    }

    ''
    '卸载完成。'
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$specifier = if ($Hot) { "$packageBase-live-$stamp" } else { $packageBase }
$dest = Join-Path $deployRoot "deploy-$stamp"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($file in 'package.json', 'cordis.patch.yml', 'README.md') {
    $from = Join-Path $sourceDir $file
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $dest }
}
foreach ($dir in 'lib', 'assets') {
    $from = Join-Path $sourceDir $dir
    if (-not (Test-Path -LiteralPath $from)) { throw "源目录缺少 $dir : $from" }
    Copy-Item -LiteralPath $from -Destination $dest -Recurse
}
$fileCount = (Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object).Count
"✓ 已落地副本: $dest  ($fileCount 个文件)"

$pkgCopyPath = Join-Path $dest 'package.json'
$pkgCopy = Get-Content -LiteralPath $pkgCopyPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pkgCopy.name = $specifier
[System.IO.File]::WriteAllText($pkgCopyPath, (ConvertTo-Json $pkgCopy -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
"✓ 副本包名: $specifier"

# 浏览器半侧的模块 id **必须等于包名**（宿主 dsh-client-modules 会硬校验
# "loaded without registering <id> via __ModuleLoader__.load"），
# 所以热更新换包名时，client.js 里的 id 也要同步改写。
$clientPath = Join-Path $dest 'lib\client.js'
if (Test-Path -LiteralPath $clientPath) {
    $clientText = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
    $patched = $clientText.Replace("id: '$packageBase', // __PKG_ID__", "id: '$specifier', // __PKG_ID__")
    if ($patched -ne $clientText) {
        [System.IO.File]::WriteAllText($clientPath, $patched, (New-Object System.Text.UTF8Encoding($false)))
        "✓ 客户端模块 id: $specifier"
    }
    else {
        "! 未在 client.js 里找到 __PKG_ID__ 标记：浏览器半侧可能仍注册旧包名 id"
    }
}

if (-not (Test-Path -LiteralPath $modulesDir)) { New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null }
Remove-PluginLinks $specifier
$linkPath = Join-Path $modulesDir $specifier
New-Item -ItemType Junction -Path $linkPath -Target $dest | Out-Null
"✓ junction: $specifier  →  $dest"

if (-not (Test-Path -LiteralPath (Join-Path $linkPath 'package.json'))) { throw 'junction 建好但解析不到 package.json，安装中止' }

if ($Mode -eq 'guardian') {
    Invoke-GuardianApi 'remove' @{ id = $entryId } | Out-Null
    Start-Sleep -Milliseconds 500
    $result = Invoke-GuardianApi 'staged' @{ id = $entryId; name = $specifier }
    if ($result -and $result.ok) {
        '✓ 已通过守护接口热挂载（无需重启）'
        $promoted = $result.value.promoted | Where-Object { $_.id -eq $entryId }
        if ($promoted) { "  当前条目: id=$($promoted.id)  name=$($promoted.name)  status=$($promoted.status)" }
    }
    else {
        $stagedPath = Join-Path $profileDir 'cordis.staged.json'
        $list = @(Get-JsonFile $stagedPath @()) | Where-Object { $_.id -ne $entryId }
        $list = @($list) + [pscustomobject]@{ id = $entryId; name = $specifier }
        Save-JsonFile $stagedPath $list
        '✓ 已写入 cordis.staged.json（守护接口不可达，将在下次启动时挂载）'
    }
    ''
    '验证：每轮对话收尾应听到语音；硬证据在 $DSH_HOME/voice-notify.log'
    '      （每次尝试一行 PLAY/FAIL/MISS，PLAY 后的秒数是 PlaySync() 的真实时长）。'
}
else {
    $pkgPath = Join-Path $profileDir 'package.json'
    $pkg = Get-JsonFile $pkgPath $null
    if (-not $pkg) { throw "读不到 profile package.json: $pkgPath" }
    if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
    $pkg.dependencies | Add-Member -NotePropertyName $specifier -NotePropertyValue ('link:' + ($dest -replace '\\', '/')) -Force
    if (-not $pkg.dsh) { throw 'profile package.json 缺少 dsh 字段，无法登记 bundles' }
    if ($pkg.dsh.profile.bundles -notcontains $specifier) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $specifier
    }
    Save-JsonFile $pkgPath $pkg
    "✓ 已登记 dependencies + dsh.profile.bundles: $specifier"
    ''
    '⚠️ 名册模式需要**重启 DSH** 才生效（启动名册 all-or-nothing）。'
}