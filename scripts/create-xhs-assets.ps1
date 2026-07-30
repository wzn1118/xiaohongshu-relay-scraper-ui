param(
  [string]$OutputDir = "$(Split-Path -Parent $PSScriptRoot)\marketing\xiaohongshu-assets"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourceHero = Join-Path $root 'output\playwright\homepage-desktop.png'
$sourceWorkflow = Join-Path $root 'output\playwright\current-workflow.png'
$sourceResults = Join-Path $root 'output\playwright\results-panel-live.png'
$sourceMobile = Join-Path $root 'mobile-workflow.png'

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function New-Brush([string]$hex) {
  return [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex))
}

function New-Font([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
  if ($size -le 0) { $size = 20 }
  return [System.Drawing.Font]::new('Microsoft YaHei UI', [float]$size, $style)
}

function Draw-Text($g, [string]$text, [float]$x, [float]$y, [float]$w, [float]$h, [float]$size, [string]$color, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular, [System.Drawing.StringAlignment]$alignment = [System.Drawing.StringAlignment]::Near) {
  $font = New-Font $size $style
  $brush = New-Brush $color
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = $alignment
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
  $g.DrawString($text, $font, $brush, [System.Drawing.RectangleF]::new($x, $y, $w, $h), $format)
  $format.Dispose()
  $brush.Dispose()
  $font.Dispose()
}

function Draw-ImageFit($g, [System.Drawing.Image]$image, [float]$x, [float]$y, [float]$w, [float]$h, [string]$background = '#FFFFFF') {
  $bg = New-Brush $background
  $g.FillRectangle($bg, $x, $y, $w, $h)
  $bg.Dispose()
  $scale = [Math]::Min($w / $image.Width, $h / $image.Height)
  $drawW = $image.Width * $scale
  $drawH = $image.Height * $scale
  $drawX = $x + (($w - $drawW) / 2)
  $drawY = $y + (($h - $drawH) / 2)
  $g.DrawImage($image, [System.Drawing.RectangleF]::new($drawX, $drawY, $drawW, $drawH))
}

function Draw-ImageCrop($g, [System.Drawing.Image]$image, [float]$x, [float]$y, [float]$w, [float]$h, [int]$sourceTop, [int]$sourceHeight, [string]$background = '#FFFFFF') {
  $bg = New-Brush $background
  $g.FillRectangle($bg, $x, $y, $w, $h)
  $bg.Dispose()
  $source = [System.Drawing.Rectangle]::new(0, $sourceTop, $image.Width, [Math]::Min($sourceHeight, $image.Height - $sourceTop))
  $g.DrawImage($image, [System.Drawing.RectangleF]::new($x, $y, $w, $h), $source, [System.Drawing.GraphicsUnit]::Pixel)
}

function Save-Canvas($bitmap, [string]$path) {
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function New-Canvas([int]$width, [int]$height, [string]$background) {
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $brush = New-Brush $background
  $g.FillRectangle($brush, 0, 0, $width, $height)
  $brush.Dispose()
  return @($bitmap, $g)
}

$hero = [System.Drawing.Image]::FromFile($sourceHero)
$workflow = [System.Drawing.Image]::FromFile($sourceWorkflow)
$results = [System.Drawing.Image]::FromFile($sourceResults)
$mobile = [System.Drawing.Image]::FromFile($sourceMobile)

$canvasPair = New-Canvas 1080 1440 '#F4F1EB'; $canvas=$canvasPair[0]; $g=$canvasPair[1]
$dark = New-Brush '#202329'; $g.FillRectangle($dark, 0, 0, 1080, 610); $dark.Dispose()
$red = New-Brush '#E9334B'; $g.FillRectangle($red, 64, 64, 104, 10); $red.Dispose()
Draw-Text $g 'LOCAL-FIRST JOB INTELLIGENCE' 64 98 820 35 22 '#F6B0B8' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '小红书实习岗位' 64 150 900 82 64 '#FFFFFF' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g 'AI 求职助手' 64 235 900 92 76 '#FFFFFF' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '把岗位信息，变成可投递材料。' 64 348 900 55 31 '#E6E6E2'
Draw-Text $g '岗位发现  ×  简历匹配  ×  求职信生成' 64 421 900 40 24 '#F6B0B8'
Draw-Text $g '本地优先 · 可复核 · 可导出' 64 520 880 42 23 '#FFFFFF'
Draw-ImageFit $g $hero 64 650 952 565 '#FFFFFF'
$line = New-Brush '#D8D4CC'; $g.FillRectangle($line, 64, 1250, 952, 2); $line.Dispose()
Draw-Text $g '01 连接浏览器' 64 1283 270 45 24 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '02 运行采集' 405 1283 270 45 24 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '03 编辑并导出' 746 1283 270 45 24 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '真实产品界面截图 · 用于产品介绍' 64 1355 952 35 20 '#77746D'
Save-Canvas $canvas (Join-Path $OutputDir '01-cover.png'); $g.Dispose()

$canvasPair = New-Canvas 1080 1440 '#F4F1EB'; $canvas=$canvasPair[0]; $g=$canvasPair[1]
Draw-Text $g '01 / 配置任务' 60 55 900 65 46 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '填写关键词，连接 Relay 和 AI Runtime，再启动全流程。' 60 130 960 48 25 '#5D5A54'
Draw-ImageFit $g $workflow 50 220 980 780 '#FFFFFF'
$card = New-Brush '#EAF3EF'; $g.FillRectangle($card, 50, 1050, 980, 250); $card.Dispose()
Draw-Text $g '配置顺序' 82 1082 250 40 26 '#147A64' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '1  打开托管浏览器并完成登录' 82 1140 860 35 22 '#202329'
Draw-Text $g '2  导入简历，核对候选人信息' 82 1190 860 35 22 '#202329'
Draw-Text $g '3  填写关键词，点击启动全流程' 82 1240 860 35 22 '#202329'
Draw-Text $g '不需要先整理多个表格，工作台会把状态集中显示。' 60 1350 960 38 20 '#77746D'
Save-Canvas $canvas (Join-Path $OutputDir '02-config.png'); $g.Dispose()

$canvasPair = New-Canvas 1080 1440 '#F4F1EB'; $canvas=$canvasPair[0]; $g=$canvasPair[1]
Draw-Text $g '02 / 查看结果' 60 55 900 65 46 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '岗位正文、匹配信息和私信 / 邮件 / Cover Letter 在同一页检查。' 60 130 960 48 25 '#5D5A54'
Draw-ImageCrop $g $results 90 220 900 820 0 800 '#FFFFFF'
Draw-Text $g '先看证据，再改文案；质量门禁通过后，人工确认再投递。' 60 1095 960 42 24 '#202329' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '支持复制私信、打开岗位、按本机 SMTP 配置发送邮件和导出文件。' 60 1165 960 40 21 '#77746D'
Save-Canvas $canvas (Join-Path $OutputDir '03-result.png'); $g.Dispose()

$canvasPair = New-Canvas 1080 1440 '#202329'; $canvas=$canvasPair[0]; $g=$canvasPair[1]
Draw-Text $g '03 / 移动端查看' 60 65 900 65 46 '#FFFFFF' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g '电脑端运行，手机端快速查看配置和任务状态。' 60 145 900 48 25 '#D9D9D4'
Draw-ImageCrop $g $mobile 560 250 420 900 0 760 '#FFFFFF'
Draw-Text $g '任务状态' 70 355 390 50 31 '#F6B0B8' ([System.Drawing.FontStyle]::Bold)
Draw-Text $g 'Relay 是否连接' 70 435 390 38 24 '#FFFFFF'
Draw-Text $g 'AI 会话是否就绪' 70 500 390 38 24 '#FFFFFF'
Draw-Text $g '候选人资料是否完整' 70 565 390 38 24 '#FFFFFF'
Draw-Text $g '采集任务是否可启动' 70 630 390 38 24 '#FFFFFF'
Draw-Text $g '关键信息集中在一个工作台里，进度和待处理项一眼可见。' 70 850 420 150 23 '#D9D9D4'
Draw-Text $g '真实产品界面截图 · 移动端适配' 60 1315 960 35 20 '#A9A7A0'
Save-Canvas $canvas (Join-Path $OutputDir '04-mobile.png'); $g.Dispose()

$hero.Dispose(); $workflow.Dispose(); $results.Dispose(); $mobile.Dispose()
Write-Output "Created XHS assets in $OutputDir"
