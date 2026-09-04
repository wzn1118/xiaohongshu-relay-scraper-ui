[CmdletBinding()]
param(
    [string]$OutputPath = 'deliverables/xiaohongshu-relay-scraper-ui-one-click-windows.zip',
    [string]$SourceRef = 'HEAD',
    [string]$ArchiveRoot = 'xiaohongshu-relay-scraper-ui'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$git = Get-Command git -ErrorAction Stop

if ([IO.Path]::IsPathRooted($OutputPath)) {
    $resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
} else {
    $resolvedOutputPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath))
}

$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$resolvedOutputPath.sha256" -Force -ErrorAction SilentlyContinue

& $git.Source -C $repositoryRoot rev-parse --verify "$SourceRef^{commit}" *> $null
if ($LASTEXITCODE -ne 0) { throw "Git source ref does not resolve to a commit: $SourceRef" }
$commit = (& $git.Source -C $repositoryRoot rev-parse "$SourceRef^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or -not $commit) { throw "Could not resolve Git source ref: $SourceRef" }

& $git.Source -C $repositoryRoot archive --format=zip "--prefix=$ArchiveRoot/" -o $resolvedOutputPath $SourceRef
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $resolvedOutputPath -PathType Leaf)) {
    throw 'Git archive creation failed.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($resolvedOutputPath)
try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $required = @(
        'README.md',
        'ONE_CLICK_START.md',
        'start-windows.cmd',
        'start-linux-macos.sh',
        'scripts/one-click.ps1',
        'scripts/one-click.sh',
        'scripts/bootstrap.ps1',
        'scripts/bootstrap.sh',
        'scripts/ensure-windows-prerequisites.ps1',
        'package.json',
        'package-lock.json',
        'requirements.txt',
        '.env.example',
        'server/index.mjs',
        'src/main.tsx'
    )
    foreach ($relativePath in $required) {
        $expected = "$ArchiveRoot/$relativePath"
        if ($entryNames -notcontains $expected) { throw "Release archive is missing required entry: $relativePath" }
    }

    foreach ($entryName in $entryNames) {
        $relative = if ($entryName.StartsWith("$ArchiveRoot/")) {
            $entryName.Substring($ArchiveRoot.Length + 1)
        } else {
            $entryName
        }
        if (-not $relative -or $relative.EndsWith('/')) { continue }
        if ($relative -match '(^|/)(\.git|node_modules|dist|data|runtime|\.runtime|test-results|playwright-report)(/|$)') {
            throw "Release archive contains a forbidden runtime directory: $relative"
        }
        if ($relative -match '(^|/)\.env($|\.)' -and $relative -notmatch '\.example$') {
            throw "Release archive contains a private environment file: $relative"
        }
        if ($relative -match '\.(?:sqlite|sqlite3|db|log|pem|pfx|key)$') {
            throw "Release archive contains a private or generated file: $relative"
        }
    }

    foreach ($entry in $archive.Entries) {
        if ($entry.FullName.EndsWith('/')) { continue }
        $stream = $entry.Open()
        try {
            $buffer = New-Object byte[] 65536
            while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { }
        } finally {
            $stream.Dispose()
        }
    }
} finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedOutputPath).Hash.ToLowerInvariant()
$checksumPath = "$resolvedOutputPath.sha256"
$checksumLine = "$hash  $([IO.Path]::GetFileName($resolvedOutputPath))`n"
[IO.File]::WriteAllText($checksumPath, $checksumLine, (New-Object Text.UTF8Encoding($false)))

[ordered]@{
    archive = $resolvedOutputPath
    checksum = $checksumPath
    sha256 = $hash
    sourceRef = $SourceRef
    commit = $commit
    entryCount = $entryNames.Count
} | ConvertTo-Json
