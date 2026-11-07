param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Lang = ""
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# engine: explicit -Lang > zh-Hans-CN > ja > en-US > profile
$engine = $null
$want = @()
if ($Lang) { $want += $Lang }
$want += @('zh-Hans-CN', 'ja', 'en-US')
try { $avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) } catch { $avail = @() }
foreach ($tag in $want) {
  if ($avail -notcontains $tag) { continue }
  try {
    $langObj = New-Object Windows.Globalization.Language -ArgumentList $tag
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
    if ($engine) { break }
  } catch { }
}
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) {
  [Console]::Out.WriteLine('{"ok":false,"error":"no-ocr-engine"}')
  exit 0
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; error = ("OCR failed: " + $_.Exception.Message) } | ConvertTo-Json -Compress))
  exit 0
}

$rows = @()
foreach ($line in $result.Lines) {
  $w = @($line.Words)
  if ($w.Count -eq 0) { continue }
  $x0 = ($w | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $y0 = ($w | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $x1 = ($w | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $y1 = ($w | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  $txt = [string]$line.Text
  $rows += [pscustomobject]@{
    text     = $txt
    compact  = ($txt -replace '\s+', '')
    x        = [int]$x0
    y        = [int]$y0
    w        = [int]([math]::Max(1, $x1 - $x0))
    h        = [int]([math]::Max(1, $y1 - $y0))
  }
}

$out = [pscustomobject]@{
  ok    = $true
  lang  = [string]$engine.RecognizerLanguage.LanguageTag
  count = $rows.Count
  ms    = [int]$sw.ElapsedMilliseconds
  lines = $rows
}
[Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 6 -Compress))
