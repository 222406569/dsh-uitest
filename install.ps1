param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [string]$Profile = '',
  [string]$Source = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$bundleName = '@local/dsh-uitest'
$linkName = 'dsh-uitest'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Source) { $Source = Join-Path $here 'bundle' }
if (-not $Profile) { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

if (-not (Test-Path $Source)) { throw "找不到插件目录：$Source" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "插件目录里没有 package.json：$Source" }
if (-not (Test-Path $Profile)) {
  throw "找不到 DSH profile：$Profile`n请先用 DSH 打开一次桌面端（会自动创建 profile），或用 -Profile 指定。"
}

$pj = Join-Path $Profile 'package.json'
$nm = Join-Path $Profile 'node_modules\@local'
$link = Join-Path $nm $linkName

function Read-ProfileJson {
  if (-not (Test-Path $pj)) { throw "找不到 $pj" }
  return [IO.File]::ReadAllText($pj, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-ProfileJson($obj) {
  $json = $obj | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($pj, $json, [Text.UTF8Encoding]::new($false))
}

Write-Host "== dsh-uitest $Action =="
Write-Host "profile : $Profile"
Write-Host "插件源  : $Source"
Write-Host "链接    : $link"
if ($DryRun) { Write-Host '（DryRun：只打印，不改动）' }

if ($Action -eq 'install') {
  $obj = Read-ProfileJson
  if ($null -eq $obj.dsh) { throw 'profile package.json 结构异常：缺 dsh 字段' }
  if ($null -eq $obj.dsh.profile) { throw 'profile package.json 结构异常：缺 dsh.profile 字段' }
  $bundles = @($obj.dsh.profile.bundles)
  $hasBundle = $bundles -contains $bundleName

  if (-not $hasBundle) {
    if ($DryRun) {
      Write-Host "[dry] 往 bundles 追加 $bundleName"
    } else {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $pj "$pj.bak-$stamp" -Force
      Write-Host "已备份 profile：package.json.bak-$stamp"
      $obj.dsh.profile.bundles = @($bundles + $bundleName)
      Write-ProfileJson $obj
      Write-Host "已登记 $bundleName"
    }
  } else {
    Write-Host "bundles 里已有 $bundleName，跳过"
  }

  if (Test-Path $link) {
    $it = Get-Item -LiteralPath $link -Force
    if ($it.LinkType -eq 'Junction') {
      Write-Host "链接已存在 -> $($it.Target)"
    } else {
      Write-Warning "目标是真实目录而不是 junction：$link（不覆盖，请手工确认）"
    }
  } else {
    if ($DryRun) {
      Write-Host "[dry] 创建 junction：$link -> $Source"
    } else {
      if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Force -Path $nm | Out-Null }
      & cmd.exe /c mklink /J "`"$link`"" "`"$Source`"" | Out-Null
      if (-not (Test-Path (Join-Path $link 'host.js'))) { throw 'junction 创建失败' }
      Write-Host "已创建 junction"
    }
  }

  # 用户用例目录：装好后放示例，方便直接改
  $userCases = Join-Path $env:USERPROFILE '.dsh\uitest\cases'
  $exSrc = Join-Path $here 'examples\cases'
  if ((Test-Path $exSrc) -and -not (Test-Path $userCases)) {
    if ($DryRun) {
      Write-Host "[dry] 复制示例用例到 $userCases"
    } else {
      try {
        New-Item -ItemType Directory -Force -Path $userCases | Out-Null
        Copy-Item (Join-Path $exSrc '*') $userCases -Force
        Write-Host "已复制示例用例到 $userCases"
      } catch {
        Write-Warning "示例用例没复制成功（不影响插件本身）：$($_.Exception.Message)"
        Write-Warning "可手工把 examples\cases 复制到 $userCases"
      }
    }
  }

  Write-Host ''
  Write-Host '完成。接下来：'
  Write-Host '  1) 重启 DSH（关闭后重新打开），侧边栏/工具里会出现 ui_* 工具'
  Write-Host '  2) 对话里说：「ui_windows 看看有哪些窗口」或直接「跑一下 cases 里的用例」'
  Write-Host '  3) 或者不重启，直接用命令行：node bin\run-cases.mjs --dir <用例目录> --out <证据目录>'
}
elseif ($Action -eq 'uninstall') {
  $obj = Read-ProfileJson
  $bundles = @($obj.dsh.profile.bundles)
  if ($bundles -contains $bundleName) {
    if ($DryRun) {
      Write-Host "[dry] 从 bundles 移除 $bundleName"
    } else {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $pj "$pj.bak-$stamp" -Force
      $obj.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $bundleName })
      Write-ProfileJson $obj
      Write-Host "已从 bundles 移除 $bundleName（备份 package.json.bak-$stamp）"
    }
  } else {
    Write-Host "bundles 里没有 $bundleName"
  }

  if (Test-Path $link) {
    $it = Get-Item -LiteralPath $link -Force
    if ($it.LinkType -eq 'Junction') {
      if ($DryRun) {
        Write-Host "[dry] 删除 junction $link"
      } else {
        & cmd.exe /c rmdir "`"$link`"" | Out-Null
        Write-Host '已删除 junction（插件源目录和数据都没动）'
      }
    } else {
      Write-Warning "不是 junction，未删除：$link"
    }
  }
  Write-Host ''
  Write-Host '卸载完成：插件源目录、~/.dsh/uitest 下的用例与运行记录都保留了。'
}
