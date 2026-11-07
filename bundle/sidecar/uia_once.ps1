param([Parameter(Mandatory=$true)][string]$ReqFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-WindowByTitle([string]$title) {
  $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
  foreach ($p in $procs) {
    if ($p.MainWindowTitle -and $p.MainWindowTitle.Contains($title)) {
      return @{ hwnd = [int64]$p.MainWindowHandle; title = $p.MainWindowTitle; pid = $p.Id }
    }
  }
  return $null
}

function Get-Root($req) {
  if ($req.hwnd) { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$req.hwnd) }
  if ($req.title) {
    $w = Get-WindowByTitle([string]$req.title)
    if ($null -eq $w) { throw "找不到标题包含 '$($req.title)' 的窗口" }
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.hwnd)
  }
  throw "需要 hwnd 或 title"
}

function Get-PatternList($el) {
  $names = @()
  foreach ($p in @(
      [System.Windows.Automation.InvokePattern]::Pattern,
      [System.Windows.Automation.ValuePattern]::Pattern,
      [System.Windows.Automation.SelectionItemPattern]::Pattern,
      [System.Windows.Automation.SelectionPattern]::Pattern,
      [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
      [System.Windows.Automation.TogglePattern]::Pattern,
      [System.Windows.Automation.TextPattern]::Pattern,
      [System.Windows.Automation.GridPattern]::Pattern,
      [System.Windows.Automation.TablePattern]::Pattern,
      [System.Windows.Automation.ScrollPattern]::Pattern)) {
    $o = $null
    try { if ($el.TryGetCurrentPattern($p, [ref]$o)) { $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.', '' -replace 'Pattern$', '') } } catch { }
  }
  return ($names -join ',')
}

function Get-ElementInfo($el, [int]$depth) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  return [pscustomobject]@{
    depth   = $depth
    type    = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
    id      = [string]$c.AutomationId
    name    = [string]$c.Name
    cls     = [string]$c.ClassName
    enabled = [bool]$c.IsEnabled
    off     = [bool]$c.IsOffscreen
    rect    = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
    pats    = (Get-PatternList $el)
  }
}

function Match-Element($el, $req) {
  try {
    $c = $el.Current
    if ($req.id -and [string]$c.AutomationId -ne [string]$req.id) { return $false }
    if ($req.type) {
      $t = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
      if ($t -ne [string]$req.type) { return $false }
    }
    if ($req.name) {
      if (-not $c.Name) { return $false }
      if ($req.nameExact) { if ([string]$c.Name -ne [string]$req.name) { return $false } }
      elseif (-not ([string]$c.Name).Contains([string]$req.name)) { return $false }
    }
    if ($req.enabledOnly -and -not $c.IsEnabled) { return $false }
    return $true
  } catch { return $false }
}

function Find-Elements($root, $req) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TRUE_COND)
  $hits = New-Object System.Collections.ArrayList
  foreach ($el in $all) { if (Match-Element $el $req) { [void]$hits.Add($el) } }
  return $hits
}

# ---------------------------------------------------------------- 命令实现

$handlers = @{

  'windows' = {
    param($req)
    $Proc = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window)
    $wins = $Proc.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $rows = @()
    foreach ($w in $wins) {
      $c = $w.Current
      $r = $c.BoundingRectangle
      $rows += [pscustomobject]@{
        hwnd  = [int64]$c.NativeWindowHandle
        title = [string]$c.Name
        pid   = [int]$c.ProcessId
        cls   = [string]$c.ClassName
        rect  = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
        off   = [bool]$c.IsOffscreen
      }
    }
    return @{ ok = $true; count = $rows.Count; windows = $rows }
  }

  'tree' = {
    param($req)
    $root = Get-Root $req
    $maxDepth = if ($req.depth) { [int]$req.depth } else { 4 }
    $maxNodes = if ($req.max) { [int]$req.max } else { 300 }
    $scope = if ($req.scope -eq 'raw') { [System.Windows.Automation.TreeScope]::Descendants } else { [System.Windows.Automation.TreeScope]::Descendants }
    $all = $root.FindAll($scope, $TRUE_COND)
    $rows = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($el in $all) {
      if ($n -ge $maxNodes) { break }
      try {
        $info = Get-ElementInfo $el 0
        if ($req.type -and $info.type -ne $req.type) { continue }
        [void]$rows.Add($info)
        $n++
      } catch { }
    }
    return @{ ok = $true; total = $all.Count; shown = $rows.Count; elements = $rows }
  }

  'find' = {
    param($req)
    $root = Get-Root $req
    $hits = Find-Elements $root $req
    $idx = if ($req.index) { [int]$req.index } else { 0 }
    if ($hits.Count -eq 0) { return @{ ok = $true; found = $false; matches = 0 } }
    if ($idx -ge $hits.Count) { return @{ ok = $false; found = $false; matches = $hits.Count; error = "index $idx 超出匹配数 $($hits.Count)" } }
    return @{ ok = $true; found = $true; matches = $hits.Count; element = (Get-ElementInfo $hits[$idx] 0) }
  }

  'invoke' = {
    param($req)
    $root = Get-Root $req
    $hits = Find-Elements $root $req
    if ($hits.Count -eq 0) { throw "没找到控件（id='$($req.id)' name='$($req.name)' type='$($req.type)'）" }
    $idx = if ($req.index) { [int]$req.index } else { 0 }
    $el = $hits[$idx]
    $before = (Get-ElementInfo $el 0)
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
      $p.Invoke()
      return @{ ok = $true; via = 'InvokePattern'; element = $before }
    }
    $p2 = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p2)) {
      $p2.Select()
      return @{ ok = $true; via = 'SelectionItemPattern.Select'; element = $before }
    }
    return @{ ok = $false; via = 'none'; element = $before; error = '该控件不支持 Invoke/SelectionItem，需要鼠标兜底' }
  }

  'set' = {
    param($req)
    $root = Get-Root $req
    $hits = Find-Elements $root $req
    if ($hits.Count -eq 0) { throw "没找到控件（id='$($req.id)' name='$($req.name)'）" }
    $idx = if ($req.index) { [int]$req.index } else { 0 }
    $el = $hits[$idx]
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
      $p.SetValue([string]$req.value)
      return @{ ok = $true; via = 'ValuePattern.SetValue'; value = [string]$req.value }
    }
    return @{ ok = $false; error = '该控件不支持 ValuePattern；可试试键盘输入兜底' }
  }

  'read' = {
    param($req)
    $root = Get-Root $req
    $hits = Find-Elements $root $req
    if ($hits.Count -eq 0) { throw "没找到控件（id='$($req.id)' name='$($req.name)'）" }
    $idx = if ($req.index) { [int]$req.index } else { 0 }
    $el = $hits[$idx]
    $info = Get-ElementInfo $el 0
    $prop = if ($req.prop) { [string]$req.prop } else { 'Name' }
    $val = $null
    switch ($prop) {
      'Name' { $val = $info.name }
      'Id' { $val = $info.id }
      'Type' { $val = $info.type }
      'Enabled' { $val = $info.enabled }
      'Offscreen' { $val = $info.off }
      'Value' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $val = $p.Current.Value }
        else { $val = $null }
      }
      'Text' {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) { $val = $p.DocumentRange.GetText(4000) }
        else { $val = $null }
      }
      default { $val = $info.name }
    }
    return @{ ok = $true; prop = $prop; value = $val; element = $info; matches = $hits.Count }
  }

  'assert' = {
    param($req)
    $root = Get-Root $req
    $results = @()
    $i = 0
    foreach ($chk in @($req.checks)) {
      $i++
      try {
        # 每条检查可单独指定窗口（跨窗口断言：点了按钮弹出的新窗体）
        $chkRoot = $root
        if ($chk.hwnd -or $chk.title) { $chkRoot = Get-Root $chk }
        $hits = Find-Elements $chkRoot $chk
        $exp = $chk.expect
        $ok = $true
        $detail = ''
        if ($null -eq $exp) { $exp = @{ exists = $true } }
        if ($null -ne $exp.exists) {
          $wantExists = [bool]$exp.exists
          if ($wantExists -and $hits.Count -eq 0) { $ok = $false; $detail += '期望存在但没找到; ' }
          if (-not $wantExists -and $hits.Count -gt 0) { $ok = $false; $detail += "期望不存在但找到 $($hits.Count) 个; " }
        }
        if ($null -ne $exp.count) {
          if ($hits.Count -ne [int]$exp.count) { $ok = $false; $detail += "数量 $($hits.Count) != 期望 $($exp.count); " }
        }
        if ($hits.Count -gt 0 -and ($null -ne $exp.name -or $null -ne $exp.enabled -or $null -ne $exp.offscreen)) {
          $info = Get-ElementInfo $hits[0] 0
          if ($null -ne $exp.name -and $info.name -ne [string]$exp.name) { $ok = $false; $detail += "name '$($info.name)' != '$($exp.name)'; " }
          if ($null -ne $exp.enabled -and $info.enabled -ne [bool]$exp.enabled) { $ok = $false; $detail += "enabled $($info.enabled) != $($exp.enabled); " }
          if ($null -ne $exp.offscreen -and $info.off -ne [bool]$exp.offscreen) { $ok = $false; $detail += "offscreen $($info.off) != $($exp.offscreen); " }
        }
        $sel = ''
        if ($chk.id) { $sel += "id=$($chk.id) " }
        if ($chk.name) { $sel += "name=$($chk.name) " }
        if ($chk.type) { $sel += "type=$($chk.type)" }
        $results += [pscustomobject]@{
          i = $i; ok = $ok; matches = $hits.Count; sel = $sel.Trim(); detail = $detail.Trim()
        }
      } catch {
        $results += [pscustomobject]@{ i = $i; ok = $false; matches = 0; sel = '?'; detail = "异常: $($_.Exception.Message)" }
      }
    }
    $failed = @($results | Where-Object { -not $_.ok }).Count
    return @{ ok = ($failed -eq 0); failed = $failed; total = $results.Count; results = $results }
  }

  'controls' = {
    param($req)
    $root = Get-Root $req
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TRUE_COND)
    $rows = @()
    foreach ($el in $all) {
      try {
        $info = Get-ElementInfo $el 0
        if ($info.pats -match 'Invoke|Value|SelectionItem|Toggle|ExpandCollapse') { $rows += $info }
      } catch { }
    }
    return @{ ok = $true; count = $rows.Count; elements = $rows }
  }

  'wait' = {
    param($req)
    $timeout = if ($req.timeoutMs) { [int]$req.timeoutMs } else { 5000 }
    $poll = if ($req.pollMs) { [int]$req.pollMs } else { 250 }
    $wantGone = ([string]$req.state -eq 'gone') -or ([string]$req.state -eq 'absent')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $last = 0
    while ($true) {
      try {
        $root = Get-Root $req
        $hits = Find-Elements $root $req
        $last = $hits.Count
        $hit = ($hits.Count -gt 0)
        if ($wantGone) { if (-not $hit) { return @{ ok = $true; state = 'gone'; matches = 0; waitedMs = [int]$sw.ElapsedMilliseconds } } }
        else { if ($hit) { return @{ ok = $true; state = 'exists'; matches = $last; waitedMs = [int]$sw.ElapsedMilliseconds } } }
      } catch { }
      if ($sw.ElapsedMilliseconds -ge $timeout) {
        return @{ ok = $false; state = $(if ($wantGone) { 'still-there' } else { 'missing' }); matches = $last; waitedMs = [int]$sw.ElapsedMilliseconds; error = "等待超时（$timeout ms）" }
      }
      Start-Sleep -Milliseconds $poll
    }
  }

  'screenshot' = {
    param($req)
    Add-Type -AssemblyName System.Drawing
    $root = Get-Root $req
    $r = $root.Current.BoundingRectangle
    $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
    if ($w -le 0 -or $h -le 0) { return @{ ok = $false; error = '窗口矩形无效' } }
    $out = [string]$req.out
    if (-not $out) { $out = Join-Path $env:TEMP ("uitest-shot-" + [guid]::NewGuid().ToString('N') + ".png") }
    $dir = Split-Path -Parent $out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $g.Dispose(); $bmp.Dispose() }
    return @{ ok = $true; path = $out; rect = @($x, $y, $w, $h) }
  }
}

# ---------------------------------------------------------------- 一次性执行

try {
  $raw = [System.IO.File]::ReadAllText($ReqFile, [System.Text.Encoding]::UTF8)
  $req = $raw | ConvertFrom-Json
  $cmd = [string]$req.cmd
  if (-not $handlers.ContainsKey($cmd)) { Out-Json @{ ok = $false; error = "未知命令 $cmd" } }
  else {
    $res = & $handlers[$cmd] $req
    Out-Json $res
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}