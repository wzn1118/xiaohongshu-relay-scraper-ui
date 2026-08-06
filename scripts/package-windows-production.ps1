[CmdletBinding()]
param(
    [string]$OutputPath = '',
    [switch]$OmitNodeModules,
    [string]$PortableRuntimeRoot = '',
    [switch]$IncludeData,
    [string]$DataSource = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Copy-ReleaseTree {
    param([string]$Source, [string]$Destination)
    # Keep dependencies out of the generic tree copy so the explicit dependency
    # copy below is the only node_modules operation.
    $excludedDirectories = @('.git', '.runtime', '.cloudflared', 'data', 'scripts\data', 'artifacts', 'output', 'profiles', 'test-results', 'tmp', 'deliverables', '.playwright-cli', '.pytest_cache', '__pycache__', 'node_modules', 'dist')
    $excludedFiles = @('.env*', 'production.env.local', '*.token', 'cert.pem', 'session-secret', 'secret.json', 'secrets.json', 'credential.json', 'credentials.json', 'password.json', 'password.txt', '*-secret.json', '*-secrets.json', '*-credential.json', '*-credentials.json', '*-password.json', '*-password.txt', 'api-key.json', 'api-key.txt', 'apikey.json', 'apikey.txt', 'private-key.pem', '*.key', 'id_rsa', 'id_ed25519', '*.log', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm')
    $robocopyArgs = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($directory in $excludedDirectories) { $robocopyArgs += @('/XD', (Join-Path $Source $directory)) }
    foreach ($file in $excludedFiles) { $robocopyArgs += @('/XF', $file) }
    & robocopy.exe @robocopyArgs | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Release tree copy failed with robocopy exit code $LASTEXITCODE." }
}

function Copy-PrivateDataTree {
    param([string]$Source, [string]$Destination)
    $excludedDirectories = @('.cloudflared', 'cloudflared', 'tunnel-credentials')
    $robocopyArgs = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($directory in $excludedDirectories) { $robocopyArgs += @('/XD', (Join-Path $Source $directory)) }
    foreach ($authFile in @('users.json', 'session-secret')) { $robocopyArgs += @('/XF', (Join-Path $Source "auth\$authFile")) }
    & robocopy.exe @robocopyArgs | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Private data copy failed with robocopy exit code $LASTEXITCODE." }
}

function Get-PrivateExclusions {
    param([string]$Source)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($relative in @('auth\users.json', 'auth\session-secret')) {
        $path = Join-Path $Source $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $entries.Add([ordered]@{ path = ($relative -replace '\\', '/'); reason = 'machine authentication state' })
        }
    }
    foreach ($relative in @('.cloudflared', 'cloudflared', 'tunnel-credentials')) {
        $path = Join-Path $Source $relative
        if (Test-Path -LiteralPath $path -PathType Container) {
            $entries.Add([ordered]@{ path = "$relative/"; reason = 'tunnel credentials' })
        }
    }
    return $entries
}

function Assert-NoEmbeddedPrivateCredentials {
    param([string]$DataRoot)
    $aiConfigPath = Join-Path $DataRoot 'ai-config.json'
    if (Test-Path -LiteralPath $aiConfigPath -PathType Leaf) {
        try { $aiConfig = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($aiConfigPath)) } catch { throw "ai-config.json is not valid JSON. $($_.Exception.Message)" }
        if ($aiConfig.providers) {
            foreach ($provider in $aiConfig.providers.PSObject.Properties) {
                $apiKeyProperty = $provider.Value.PSObject.Properties['apiKey']
                if ($apiKeyProperty -and -not [string]::IsNullOrWhiteSpace([string]$apiKeyProperty.Value)) {
                    throw 'Private data contains an AI API key. Remove machine credentials before packaging.'
                }
            }
        }
    }

    $smtpConfigPath = Join-Path $DataRoot 'smtp-config.json'
    if (Test-Path -LiteralPath $smtpConfigPath -PathType Leaf) {
        try { $smtpConfig = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($smtpConfigPath)) } catch { throw "smtp-config.json is not valid JSON. $($_.Exception.Message)" }
        foreach ($name in @('pass', 'password', 'credentialVault')) {
            $property = $smtpConfig.PSObject.Properties[$name]
            if ($property -and $null -ne $property.Value -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                throw 'Private data contains SMTP credentials. Remove machine credentials before packaging.'
            }
        }
        if ($smtpConfig.oauth) {
            foreach ($name in @('clientSecret', 'refreshToken')) {
                $property = $smtpConfig.oauth.PSObject.Properties[$name]
                if ($property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                    throw 'Private data contains OAuth credentials. Remove machine credentials before packaging.'
                }
            }
        }
    }
}

function Get-JsonArrayCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required dataset file was not found: $Path" }
    try {
        $payload = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path))
    } catch {
        throw "Required dataset file is not valid JSON: $Path. $($_.Exception.Message)"
    }
    if ($payload -isnot [System.Array]) { throw "Required dataset file must contain a JSON array: $Path" }
    return [int]$payload.Count
}

function Test-ForbiddenReleasePath {
    param(
        [string]$RelativePath,
        [bool]$AllowData
    )
    $normalized = ($RelativePath -replace '\\', '/').TrimStart('/').ToLowerInvariant()
    $leaf = [IO.Path]::GetFileName($normalized)
    if (-not $AllowData -and $normalized -match '^data(?:/|$)') { return $true }
    if ($normalized -match '^scripts/data(?:/|$)') { return $true }
    if ($normalized -match '(?:^|/)\.(?:git|runtime)(?:/|$)') { return $true }
    if ($normalized -match '(?:^|/)(?:\.cloudflared|tunnel-credentials)(?:/|$)') { return $true }
    if ($leaf -match '^\.env' -and $leaf -notin @('.env.example', '.env.production.example')) { return $true }
    if ($leaf -eq 'production.env.local') { return $true }
    if ($leaf -eq 'cert.pem' -or $leaf -like '*.token') { return $true }
    if ($normalized -match '^data/auth/(?:users\.json|session-secret)$') { return $true }
    if ($leaf -match '^(?:session-secret|secret|secrets|credential|credentials|password|passwords|passwd)$') { return $true }
    if ($leaf -match '(?:^|[-_.])(?:secret|secrets|credential|credentials|password|passwords|passwd|api[-_.]?key)(?:[-_.][^.]+)*\.(?:json|ya?ml|toml|ini|conf|config|txt|pem)$') { return $true }
    if ($leaf -match '^(?:id_rsa|id_ed25519)$' -or $leaf -like '*.key') { return $true }
    if ($leaf -match '^(?:tunnel|cloudflared).*(?:credential|token).*') { return $true }
    if ($leaf -match '^tunnel.*\.json$') { return $true }
    return $false
}

function Assert-NoForbiddenReleasePaths {
    param(
        [string]$Stage,
        [bool]$AllowData
    )
    foreach ($item in Get-ChildItem -LiteralPath $Stage -Force -Recurse) {
        $relative = $item.FullName.Substring($Stage.Length).TrimStart('\', '/') -replace '\\', '/'
        if (Test-ForbiddenReleasePath -RelativePath $relative -AllowData $AllowData) {
            throw "Release staging contains a forbidden path: $relative"
        }
    }
}

function Get-Manifest {
    param([string]$Stage)
    foreach ($file in Get-ChildItem -LiteralPath $Stage -File -Recurse -Force) {
        $relative = $file.FullName.Substring($Stage.Length).TrimStart('\', '/') -replace '\\', '/'
        [ordered]@{ path = $relative; bytes = [int64]$file.Length }
    }
}

if (-not $SkipBuild) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm is required to build the release.' }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html') -PathType Leaf)) { throw 'dist/index.html is missing.' }
if (-not $OmitNodeModules -and -not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
    throw 'node_modules is required for a one-click production package.'
}
if (-not $PortableRuntimeRoot) { throw '-PortableRuntimeRoot is required for a one-click production package.' }
$runtimeSource = if ([IO.Path]::IsPathRooted($PortableRuntimeRoot)) { [IO.Path]::GetFullPath($PortableRuntimeRoot) } else { [IO.Path]::GetFullPath((Join-Path $root $PortableRuntimeRoot)) }
if (-not (Test-Path -LiteralPath $runtimeSource -PathType Container)) { throw "Portable runtime directory was not found: $runtimeSource" }
$requiredRuntimeFiles = @('node\node.exe', 'node\npm.cmd', 'python\python.exe', 'cloudflared\cloudflared.exe')
foreach ($relative in $requiredRuntimeFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource $relative) -PathType Leaf)) {
        throw "Portable runtime is incomplete: $relative"
    }
}

if ($DataSource -and -not $IncludeData) { throw '-DataSource requires -IncludeData.' }
$resolvedDataSource = ''
$dataSourceLabel = $null
$datasetTaskId = '20260804081657-caf8f451'
$workflowTaskId = '20260731005634-5c619106'
$cardsRelativePath = "jobs\$datasetTaskId\artifacts\xiaohongshu_cards_latest.json"
$notesRelativePath = "jobs\$datasetTaskId\artifacts\xiaohongshu_notes_latest.json"
$workflowStateRelativePath = "jobs\$workflowTaskId\workflow-state.json"
$sourceCardsCount = 0
$sourceNotesCount = 0
if ($IncludeData) {
    if (-not $DataSource) { throw '-DataSource is required when -IncludeData is used.' }
    $resolvedDataSource = if ([IO.Path]::IsPathRooted($DataSource)) { [IO.Path]::GetFullPath($DataSource) } else { [IO.Path]::GetFullPath((Join-Path $root $DataSource)) }
    if (-not (Test-Path -LiteralPath $resolvedDataSource -PathType Container)) { throw "Data source directory was not found: $resolvedDataSource" }
    Assert-NoEmbeddedPrivateCredentials -DataRoot $resolvedDataSource
    $dataSourceLabel = Split-Path -Leaf $resolvedDataSource.TrimEnd('\', '/')
    if (-not $dataSourceLabel) { $dataSourceLabel = 'external-data' }
    $sourceCardsCount = Get-JsonArrayCount -Path (Join-Path $resolvedDataSource $cardsRelativePath)
    $sourceNotesCount = Get-JsonArrayCount -Path (Join-Path $resolvedDataSource $notesRelativePath)
    if ($sourceCardsCount -ne 715 -or $sourceNotesCount -ne 715) {
        throw "The requested 715-item dataset is incomplete: cards=$sourceCardsCount, notes=$sourceNotesCount."
    }
    $sourceWorkflowState = Join-Path $resolvedDataSource $workflowStateRelativePath
    if (-not (Test-Path -LiteralPath $sourceWorkflowState -PathType Leaf)) {
        throw "Required workflow state was not found: $workflowStateRelativePath"
    }
}

if (-not $OutputPath) { $OutputPath = Join-Path $root ("deliverables\hegelsalon-production-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (-not [IO.Path]::IsPathRooted($OutputPath)) { $OutputPath = Join-Path $root $OutputPath }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath).ToLowerInvariant() -ne '.zip') { $OutputPath += '.zip' }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { New-Item -ItemType Directory -Path $outputParent -Force | Out-Null }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }

$stage = Join-Path ([IO.Path]::GetTempPath()) ("hegelsalon-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    Copy-ReleaseTree -Source $root -Destination $stage
    # Ship templates so a first run can create a local .env without embedding
    # machine credentials or production secrets.
    foreach ($template in @('.env.example', '.env.production.example')) {
        $templatePath = Join-Path $root $template
        if (Test-Path -LiteralPath $templatePath -PathType Leaf) {
            Copy-Item -LiteralPath $templatePath -Destination (Join-Path $stage $template) -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination (Join-Path $stage 'dist') -Recurse -Force
    foreach ($legacyLauncher in @('start-windows.cmd')) {
        $legacyLauncherPath = Join-Path $stage $legacyLauncher
        if (Test-Path -LiteralPath $legacyLauncherPath -PathType Leaf) { Remove-Item -LiteralPath $legacyLauncherPath -Force }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'start-production-windows.cmd') -PathType Leaf)) {
        throw 'Release staging is missing start-production-windows.cmd.'
    }
    if (-not $OmitNodeModules) {
        Copy-Item -LiteralPath (Join-Path $root 'node_modules') -Destination (Join-Path $stage 'node_modules') -Recurse -Force
    }
    Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $stage 'runtime') -Recurse -Force
    foreach ($relative in $requiredRuntimeFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage "runtime\$relative") -PathType Leaf)) {
            throw "Staged portable runtime is incomplete: $relative"
        }
    }
    if ($IncludeData) {
        $stageData = Join-Path $stage 'data'
        New-Item -ItemType Directory -Path $stageData -Force | Out-Null
        Copy-PrivateDataTree -Source $resolvedDataSource -Destination $stageData
        Assert-NoEmbeddedPrivateCredentials -DataRoot $stageData
        $stageCardsCount = Get-JsonArrayCount -Path (Join-Path $stageData $cardsRelativePath)
        $stageNotesCount = Get-JsonArrayCount -Path (Join-Path $stageData $notesRelativePath)
        if ($stageCardsCount -ne $sourceCardsCount -or $stageNotesCount -ne $sourceNotesCount) {
            throw "The staged dataset count does not match its source: cards=$stageCardsCount/$sourceCardsCount, notes=$stageNotesCount/$sourceNotesCount."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $stageData $workflowStateRelativePath) -PathType Leaf)) {
            throw "Staged package is missing required workflow state: data/$($workflowStateRelativePath -replace '\\', '/')"
        }
        $datasetMetadata = [ordered]@{
            schemaVersion = 1
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            includesRawData = $true
            dataSource = $dataSourceLabel
            datasetTaskId = $datasetTaskId
            cards = [ordered]@{ path = "data/$($cardsRelativePath -replace '\\', '/')"; count = $stageCardsCount }
            notes = [ordered]@{ path = "data/$($notesRelativePath -replace '\\', '/')"; count = $stageNotesCount }
            restoredWorkflow = [ordered]@{ taskId = $workflowTaskId; path = "data/$($workflowStateRelativePath -replace '\\', '/')"; present = $true }
        }
        $datasetMetadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'PORTABLE_DATASET.json') -Encoding UTF8
        Add-Content -LiteralPath (Join-Path $stage 'PORTABLE_DATASET.json') -Value ''
        [ordered]@{
            schemaVersion = 1
            excluded = @(Get-PrivateExclusions -Source $resolvedDataSource)
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'PRIVATE_EXCLUSIONS.json') -Encoding UTF8
        Add-Content -LiteralPath (Join-Path $stage 'PRIVATE_EXCLUSIONS.json') -Value ''
        @(
            'PRIVATE RAW-DATA BUNDLE - NOT FOR PUBLIC GITHUB',
            '',
            'This archive contains unredacted application data and is intended for private transfer only.',
            'Administrator accounts, session secrets, environment files, tunnel tokens, certificates, and credential files are excluded.',
            'Use the clean package for a public repository or public release.'
        ) | Set-Content -LiteralPath (Join-Path $stage 'PRIVATE-BUNDLE-NOT-FOR-GITHUB.txt') -Encoding UTF8
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        application = 'xiaohongshu-relay-scraper-ui'
        integrity = 'Verify the complete archive with the separately reported SHA-256.'
        publicHost = 'relay.hegelsalon.com'
        originPort = 4327
        includesNodeModules = (Test-Path -LiteralPath (Join-Path $stage 'node_modules') -PathType Container)
        includesPortableRuntime = ($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stage "runtime\$_") -PathType Leaf) }).Count -eq 0
        includesRawData = [bool]$IncludeData
        dataSource = $dataSourceLabel
        excluded = if ($IncludeData) { @('.git', '.runtime', 'data/auth/users.json', 'data/auth/session-secret', '.env and .env.* except *.example', '*.token', 'cert.pem', 'tunnel credentials') } else { @('.git', '.runtime', 'data', 'artifacts', 'output', 'profiles', '.env and .env.* except *.example', '*.token', 'cert.pem', 'tunnel credentials') }
        files = @(Get-Manifest -Stage $stage)
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'PORTABLE_MANIFEST.json') -Encoding UTF8
    Add-Content -LiteralPath (Join-Path $stage 'PORTABLE_MANIFEST.json') -Value ''
    Assert-NoForbiddenReleasePaths -Stage $stage -AllowData ([bool]$IncludeData)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $OutputPath, [IO.Compression.CompressionLevel]::Fastest, $false)
    $archive = [IO.Compression.ZipFile]::OpenRead($OutputPath)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        if (-not ($names -contains 'PORTABLE_MANIFEST.json')) { throw 'Archive is missing PORTABLE_MANIFEST.json.' }
        foreach ($name in $names) {
            if (Test-ForbiddenReleasePath -RelativePath $name -AllowData ([bool]$IncludeData)) {
                throw "Archive contains a forbidden secret or runtime path: $name"
            }
        }
        if ($IncludeData) {
            foreach ($requiredEntry in @('PORTABLE_DATASET.json', 'PRIVATE_EXCLUSIONS.json', 'PRIVATE-BUNDLE-NOT-FOR-GITHUB.txt', "data/$($cardsRelativePath -replace '\\', '/')", "data/$($notesRelativePath -replace '\\', '/')", "data/$($workflowStateRelativePath -replace '\\', '/')")) {
                if (-not ($names -contains $requiredEntry)) { throw "Private archive is missing required entry: $requiredEntry" }
            }
        } elseif ($names | Where-Object { $_ -match '^data(?:/|$)' }) {
            throw 'Clean archive contains a data path.'
        }
    } finally { $archive.Dispose() }
    $hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Production package created: $OutputPath"
    Write-Host "Archive SHA-256: $hash"
    Write-Host "Node dependencies included: $(-not $OmitNodeModules)"
    Write-Host "Portable runtime included: $([bool]$PortableRuntimeRoot)"
    Write-Host "Raw application data included: $([bool]$IncludeData)"
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
