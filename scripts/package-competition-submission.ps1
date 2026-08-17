[CmdletBinding()]
param(
    [string]$OutputPath = 'E:\today-you-applied-competition-715-mcp-v3.0.0-20260810.zip',
    [string]$DataSource = '',
    [int64]$MaximumBytes = 100000000,
    [switch]$SkipBuild,
    [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$datasetTaskId = '20260804081657-caf8f451'
$workflowTaskId = '20260731005634-5c619106'
$expectedCount = 715

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Copy-TreeWithRobocopy {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExcludedDirectories = @(),
        [string[]]$ExcludedFiles = @()
    )
    $arguments = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($directory in $ExcludedDirectories) { $arguments += @('/XD', $directory) }
    foreach ($file in $ExcludedFiles) { $arguments += @('/XF', $file) }
    & robocopy.exe @arguments | Out-Null
    $code = $LASTEXITCODE
    if ($code -gt 7) { throw "robocopy failed with exit code $code while copying $Source" }
    $global:LASTEXITCODE = 0
}

function Copy-RequiredFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Required file is missing: $Source" }
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-OptionalFile {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return $false }
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return $true
}

function Get-JsonRecordCount {
    param([string]$Path, [System.Management.Automation.CommandInfo]$Node)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Dataset file is missing: $Path" }
    $script = "const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const a=Array.isArray(v)?v:(Array.isArray(v.records)?v.records:(Array.isArray(v.items)?v.items:null));if(!a)process.exit(3);process.stdout.write(String(a.length));"
    $value = & $Node.Source -e $script $Path
    if ($LASTEXITCODE -ne 0) { throw "Dataset file is not a supported JSON record array: $Path" }
    return [int]$value
}

function Get-RelativeFiles {
    param([string]$RootPath)
    foreach ($file in Get-ChildItem -LiteralPath $RootPath -File -Recurse -Force) {
        $relative = $file.FullName.Substring($RootPath.Length).TrimStart('\', '/') -replace '\\', '/'
        [ordered]@{ path = $relative; bytes = [int64]$file.Length }
    }
}

function Test-ForbiddenPath {
    param([string]$RelativePath)
    $normalized = ($RelativePath -replace '\\', '/').TrimStart('/').ToLowerInvariant()
    $leaf = [IO.Path]::GetFileName($normalized)
    if ($normalized -match '(?:^|/)(?:\.git|\.runtime|\.cloudflared|node_modules|runtime)(?:/|$)') { return $true }
    if ($normalized -match '^scripts/data(?:/|$)') { return $true }
    if ($normalized -match '^data/browser(?:/|$)') { return $true }
    if ($normalized -match '^data/auth/(?:users\.json|session-secret|mcp-token-pepper)$') { return $true }
    if ($normalized -match '^data/(?:ai-config|smtp-config)[^/]*\.json$') { return $true }
    if ($leaf -match '^\.env' -and $leaf -notin @('.env.example', '.env.production.example')) { return $true }
    if ($leaf -eq 'production.env.local' -or $leaf -eq 'cert.pem' -or $leaf -like '*.token') { return $true }
    if ($leaf -match '^(?:id_rsa|id_ed25519)$' -or $leaf -like '*.key') { return $true }
    if ($leaf -match '(?:^|[-_.])(?:secret|secrets|credential|credentials|password|passwords|api[-_.]?key)(?:[-_.][^.]+)*\.(?:json|ya?ml|toml|ini|conf|config|txt|pem)$') { return $true }
    return $false
}

function Assert-NoForbiddenPaths {
    param([string]$RootPath)
    foreach ($item in Get-ChildItem -LiteralPath $RootPath -Force -Recurse) {
        $relative = $item.FullName.Substring($RootPath.Length).TrimStart('\', '/') -replace '\\', '/'
        if (Test-ForbiddenPath -RelativePath $relative) { throw "Package staging contains a forbidden path: $relative" }
    }
}

function Copy-TaskSnapshot {
    param(
        [string]$SourceData,
        [string]$StageData,
        [string]$TaskId
    )
    $sourceTask = Join-Path $SourceData "jobs\$TaskId"
    $stageTask = Join-Path $StageData "jobs\$TaskId"
    if (-not (Test-Path -LiteralPath $sourceTask -PathType Container)) { throw "Required task is missing: $TaskId" }
    New-Item -ItemType Directory -Path (Join-Path $stageTask 'artifacts') -Force | Out-Null

    Copy-RequiredFile -Source (Join-Path $sourceTask 'workflow-state.json') -Destination (Join-Path $stageTask 'workflow-state.json')
    foreach ($name in @('candidate-profile.runtime.json', 'expansion-request.json')) {
        Copy-OptionalFile -Source (Join-Path $sourceTask $name) -Destination (Join-Path $stageTask $name) | Out-Null
    }

    $artifactNames = @(
        'xiaohongshu_cards_latest.json',
        'xiaohongshu_cards_discovered.json',
        'xiaohongshu_cards_out_of_scope.json',
        'xiaohongshu_notes_latest.json',
        'xiaohongshu_notes_latest.csv',
        'xiaohongshu_notes_latest_dedup.json',
        'xiaohongshu_notes_latest_dedup.csv',
        'xiaohongshu_notes_latest_dedup.xlsx',
        'xiaohongshu_notes_structured.xlsx',
        'application_intelligence.json',
        'application_intelligence.checkpoint.json',
        'application_intelligence.csv',
        'application_intelligence.xlsx',
        'application_intelligence_summary.json',
        'application_intelligence_report.md',
        'application-contact-ocr.json',
        'application-contact-ocr-cache.json',
        'application-contact-resolution.json',
        'contact-resolution-job.json',
        'contact-resolution-report.json',
        'delivery-state.json',
        'delivery-state.v1.backup.json',
        'body-completion-ledger.json',
        'parallel-body-summary.json',
        'parallel_body_failures.json',
        'audience-comments.json',
        'audience-posts.json',
        'audience-users.json',
        'audience-failures.json',
        'audience-summary.json',
        'workflow-summary.json',
        'coverage_report.json',
        'artifact-manifest.json',
        'graph.json',
        'relations.csv',
        'comments.csv',
        'users.csv',
        'posts.csv',
        'expansion_frontier.json',
        'expansion_summary.json',
        'expansion_rounds.json'
    )
    $sourceArtifacts = Join-Path $sourceTask 'artifacts'
    $stageArtifacts = Join-Path $stageTask 'artifacts'
    foreach ($name in $artifactNames) {
        Copy-OptionalFile -Source (Join-Path $sourceArtifacts $name) -Destination (Join-Path $stageArtifacts $name) | Out-Null
    }

    foreach ($required in @('xiaohongshu_cards_latest.json', 'xiaohongshu_notes_latest.json', 'application_intelligence.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stageArtifacts $required) -PathType Leaf)) {
            throw "Task $TaskId is missing required artifact: $required"
        }
    }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { throw 'Node.js is required to validate and package the current project.' }

if (-not $SkipBuild) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required to build the package.' }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf)) { throw 'dist/index.html is missing.' }

if (-not $DataSource) { $DataSource = Join-Path $root 'data' }
$DataSource = [IO.Path]::GetFullPath($DataSource)
if (-not (Test-Path -LiteralPath $DataSource -PathType Container)) { throw "Data source does not exist: $DataSource" }

if (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $root $OutputPath }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath).ToLowerInvariant() -ne '.zip') { $OutputPath += '.zip' }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}

$stageParent = Join-Path $outputParent '.competition-package-staging'
New-Item -ItemType Directory -Path $stageParent -Force | Out-Null
$stage = Join-Path $stageParent ("competition-715-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
    $excludedDirectories = @(
        (Join-Path $root '.git'),
        (Join-Path $root '.runtime'),
        (Join-Path $root '.cloudflared'),
        (Join-Path $root '.package-staging'),
        (Join-Path $root '.competition-package-staging'),
        (Join-Path $root 'data'),
        (Join-Path $root 'scripts\data'),
        (Join-Path $root 'node_modules'),
        (Join-Path $root 'runtime'),
        (Join-Path $root 'dist'),
        (Join-Path $root 'deliverables'),
        (Join-Path $root 'artifacts'),
        (Join-Path $root 'profiles'),
        (Join-Path $root 'output'),
        (Join-Path $root 'tmp'),
        (Join-Path $root 'test-results'),
        (Join-Path $root '.playwright-cli'),
        (Join-Path $root '.pytest_cache'),
        (Join-Path $root '__pycache__')
    )
    $excludedFiles = @(
        '.env*', 'production.env.local', '*.token', '*.key', '*.log', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm',
        'cert.pem', 'session-secret', 'secret.json', 'secrets.json', 'credential.json', 'credentials.json',
        'password.json', 'password.txt', '*-secret.json', '*-secrets.json', '*-credential.json', '*-credentials.json',
        '*-password.json', '*-password.txt', 'api-key.json', 'api-key.txt', 'apikey.json', 'apikey.txt',
        'private-key.pem', 'id_rsa', 'id_ed25519'
    )
    Copy-TreeWithRobocopy -Source $root -Destination $stage -ExcludedDirectories $excludedDirectories -ExcludedFiles $excludedFiles

    foreach ($template in @('.env.example', '.env.production.example')) {
        Copy-OptionalFile -Source (Join-Path $root $template) -Destination (Join-Path $stage $template) | Out-Null
    }
    Copy-TreeWithRobocopy -Source (Join-Path $root 'dist') -Destination (Join-Path $stage 'dist')

    $stageData = Join-Path $stage 'data'
    New-Item -ItemType Directory -Path (Join-Path $stageData 'jobs') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stageData 'auth') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stageData 'copilot') -Force | Out-Null

    $sourceJobs = Join-Path $DataSource 'jobs\jobs.json'
    $stageJobs = Join-Path $stageData 'jobs\jobs.json'
    & $node.Source (Join-Path $root 'scripts\build-competition-index.mjs') $sourceJobs $stageJobs $datasetTaskId $workflowTaskId
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the compact two-task jobs index.' }

    Copy-TaskSnapshot -SourceData $DataSource -StageData $stageData -TaskId $datasetTaskId
    Copy-TaskSnapshot -SourceData $DataSource -StageData $stageData -TaskId $workflowTaskId

    $profilesSource = Join-Path $DataSource 'profiles'
    if (Test-Path -LiteralPath $profilesSource -PathType Container) {
        Copy-TreeWithRobocopy -Source $profilesSource -Destination (Join-Path $stageData 'profiles')
    }

    $cardsPath = Join-Path $stageData "jobs\$datasetTaskId\artifacts\xiaohongshu_cards_latest.json"
    $notesPath = Join-Path $stageData "jobs\$datasetTaskId\artifacts\xiaohongshu_notes_latest.json"
    $cardsCount = Get-JsonRecordCount -Path $cardsPath -Node $node
    $notesCount = Get-JsonRecordCount -Path $notesPath -Node $node
    if ($cardsCount -ne $expectedCount -or $notesCount -ne $expectedCount) {
        throw "The package does not contain the required 715 records: cards=$cardsCount notes=$notesCount"
    }

    $sourceCardsHash = (Get-FileHash -LiteralPath (Join-Path $DataSource "jobs\$datasetTaskId\artifacts\xiaohongshu_cards_latest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourceNotesHash = (Get-FileHash -LiteralPath (Join-Path $DataSource "jobs\$datasetTaskId\artifacts\xiaohongshu_notes_latest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    $stageCardsHash = (Get-FileHash -LiteralPath $cardsPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $stageNotesHash = (Get-FileHash -LiteralPath $notesPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceCardsHash -ne $stageCardsHash -or $sourceNotesHash -ne $stageNotesHash) { throw 'The 715-record dataset changed while it was copied.' }

    $profilesCount = @(Get-ChildItem -LiteralPath (Join-Path $stageData 'profiles') -File -Recurse -ErrorAction SilentlyContinue).Count
    $datasetMetadata = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        packageType = 'private-competition-submission'
        defaultTaskId = $datasetTaskId
        taskIds = @($datasetTaskId, $workflowTaskId)
        includesRawData = $true
        rawDatasetRecordsUnmodified = $true
        compactCanonicalSnapshot = $true
        cards = [ordered]@{ count = $cardsCount; sha256 = $stageCardsHash; path = "data/jobs/$datasetTaskId/artifacts/xiaohongshu_cards_latest.json" }
        notes = [ordered]@{ count = $notesCount; sha256 = $stageNotesHash; path = "data/jobs/$datasetTaskId/artifacts/xiaohongshu_notes_latest.json" }
        restoredWorkflow = [ordered]@{ taskId = $workflowTaskId; statePath = "data/jobs/$workflowTaskId/workflow-state.json" }
        profileFiles = $profilesCount
        excludedDuplicateHistory = $true
    }
    Write-Utf8NoBom -Path (Join-Path $stage 'PORTABLE_DATASET.json') -Text (($datasetMetadata | ConvertTo-Json -Depth 7) + "`n")

    $packageInfo = [ordered]@{
        schemaVersion = 1
        application = 'today-you-applied'
        version = '3.0.0'
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        startup = 'start-competition-windows.cmd'
        startupMode = 'online-first-install'
        startupBehavior = 'finds free Web and MCP ports, installs missing runtimes and dependencies, starts the app, then opens a browser'
        webUiIncluded = $true
        mcpIncluded = $true
        mcpTransports = @('HTTP Streamable MCP', 'stdio bridge')
        rawDatasetIncluded = $true
        defaultTaskId = $datasetTaskId
        note = 'This compact package omits portable runtimes and node_modules to remain below the 100 MB upload limit.'
    }
    Write-Utf8NoBom -Path (Join-Path $stage 'COMPETITION_PACKAGE_INFO.json') -Text (($packageInfo | ConvertTo-Json -Depth 6) + "`n")

    $privateExclusions = [ordered]@{
        schemaVersion = 1
        excluded = @(
            [ordered]@{ path = '.env and local production environment files'; reason = 'machine secrets' },
            [ordered]@{ path = 'data/auth'; reason = 'accounts, session secret, and MCP token pepper are regenerated on the target computer' },
            [ordered]@{ path = 'data/browser'; reason = 'browser cookies and signed-in sessions stay on the source computer' },
            [ordered]@{ path = 'data/ai-config*.json and data/smtp-config*.json'; reason = 'provider and email credentials are configured on the target computer' },
            [ordered]@{ path = 'historical timestamped duplicate artifacts'; reason = 'canonical latest artifacts preserve the working dataset while meeting the upload limit' },
            [ordered]@{ path = 'runtime and node_modules'; reason = 'downloaded automatically on first launch' }
        )
    }
    Write-Utf8NoBom -Path (Join-Path $stage 'PRIVATE_EXCLUSIONS.json') -Text (($privateExclusions | ConvertTo-Json -Depth 6) + "`n")

    $readme = @(
        '# Competition Submission Package - Read First',
        '',
        '1. Extract the complete ZIP. Do not run it inside the archive viewer.',
        '2. Double-click `start-competition-windows.cmd`.',
        '3. The first launch requires Internet access and installs missing runtimes and dependencies.',
        '4. The launcher finds free Web and MCP ports, starts all services, and opens the browser.',
        '5. The default task is `20260804081657-caf8f451` with 715 cards and 715 full-text notes.',
        '',
        'Architecture, features, data boundaries, MCP setup, and verification:',
        '`docs/COMPETITION_SUBMISSION_TECHNICAL_GUIDE.md`',
        '',
        'This package contains private raw data and attachments. Do not publish it to a public GitHub repository.'
    ) -join "`n"
    Write-Utf8NoBom -Path (Join-Path $stage 'README-FIRST.md') -Text ($readme + "`n")
    Write-Utf8NoBom -Path (Join-Path $stage 'PRIVATE-DATA-NOT-FOR-PUBLIC-GITHUB.txt') -Text ("This archive contains unredacted private application data. Use it only for the intended private competition submission.`n")

    $requiredStageFiles = @(
        'start-competition-windows.cmd',
        'scripts/start-competition-windows.ps1',
        'scripts/one-click.ps1',
        'scripts/bootstrap.ps1',
        'dist/index.html',
        'package.json',
        'package-lock.json',
        'mcp-stdio.cmd',
        'start-mcp.cmd',
        'server/mcp-http-server.mjs',
        'server/mcp-management-http.mjs',
        'scripts/mcp-stdio-bridge.mjs',
        'docs/COMPETITION_SUBMISSION_TECHNICAL_GUIDE.md',
        'PORTABLE_DATASET.json',
        'COMPETITION_PACKAGE_INFO.json',
        'README-FIRST.md'
    )
    foreach ($relative in $requiredStageFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage ($relative -replace '/', '\')) -PathType Leaf)) {
            throw "Package staging is missing required content: $relative"
        }
    }

    Assert-NoForbiddenPaths -RootPath $stage
    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        application = 'today-you-applied'
        packageType = 'private-competition-submission'
        maximumBytes = $MaximumBytes
        files = @(Get-RelativeFiles -RootPath $stage)
    }
    Write-Utf8NoBom -Path (Join-Path $stage 'PORTABLE_MANIFEST.json') -Text (($manifest | ConvertTo-Json -Depth 6) + "`n")

    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
    if (Test-Path -LiteralPath "$OutputPath.sha256") { Remove-Item -LiteralPath "$OutputPath.sha256" -Force }
    if (Test-Path -LiteralPath "$OutputPath.verification.json") { Remove-Item -LiteralPath "$OutputPath.verification.json" -Force }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $OutputPath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $archiveBytes = (Get-Item -LiteralPath $OutputPath).Length
    if ($archiveBytes -gt $MaximumBytes) { throw "Archive exceeds the upload limit: $archiveBytes > $MaximumBytes bytes" }

    $archive = [IO.Compression.ZipFile]::OpenRead($OutputPath)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        foreach ($required in ($requiredStageFiles + @(
            'PORTABLE_MANIFEST.json',
            "data/jobs/$datasetTaskId/artifacts/xiaohongshu_cards_latest.json",
            "data/jobs/$datasetTaskId/artifacts/xiaohongshu_notes_latest.json",
            "data/jobs/$datasetTaskId/artifacts/delivery-state.json",
            "data/jobs/$workflowTaskId/workflow-state.json",
            'data/jobs/jobs.json'
        ))) {
            if (-not ($entryNames -contains $required)) { throw "Archive is missing required entry: $required" }
        }
        foreach ($entryName in $entryNames) {
            if (Test-ForbiddenPath -RelativePath $entryName) { throw "Archive contains forbidden content: $entryName" }
        }
        $buffer = New-Object byte[] 131072
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $stream = $entry.Open()
            try { while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { } } finally { $stream.Dispose() }
        }
        $entryCount = $archive.Entries.Count
    } finally {
        $archive.Dispose()
    }

    $hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8NoBom -Path "$OutputPath.sha256" -Text ("$hash  $([IO.Path]::GetFileName($OutputPath))`n")
    $verification = [ordered]@{
        ok = $true
        verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
        archive = $OutputPath
        bytes = $archiveBytes
        maximumBytes = $MaximumBytes
        underLimit = $archiveBytes -le $MaximumBytes
        sha256 = $hash
        archiveEntriesRead = $entryCount
        cards = $cardsCount
        notes = $notesCount
        rawDatasetHashesMatchSource = $true
        defaultTaskId = $datasetTaskId
        workflowTaskId = $workflowTaskId
        mcpIncluded = $true
        portableRuntimeIncluded = $false
        onlineFirstInstall = $true
    }
    Write-Utf8NoBom -Path "$OutputPath.verification.json" -Text (($verification | ConvertTo-Json -Depth 5) + "`n")

    Write-Host "Competition package created: $OutputPath"
    Write-Host "Archive bytes: $archiveBytes / $MaximumBytes"
    Write-Host "Archive SHA-256: $hash"
    Write-Host "715 data retained: cards=$cardsCount notes=$notesCount"
    Write-Host "MCP included: true"
} catch {
    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath "$OutputPath.sha256") { Remove-Item -LiteralPath "$OutputPath.sha256" -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath "$OutputPath.verification.json") { Remove-Item -LiteralPath "$OutputPath.verification.json" -Force -ErrorAction SilentlyContinue }
    throw
} finally {
    if (-not $KeepStaging) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

$global:LASTEXITCODE = 0
