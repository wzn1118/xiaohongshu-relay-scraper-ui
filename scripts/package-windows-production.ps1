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
    $excludedDirectories = @('.git', '.runtime', '.cloudflared', '.package-staging', 'data', 'scripts\data', 'artifacts', 'output', 'profiles', 'test-results', 'tmp', 'deliverables', '.playwright-cli', '.pytest_cache', '__pycache__', 'node_modules', 'dist')
    $excludedFiles = @('.env*', 'production.env.local', '*.token', 'cert.pem', 'session-secret', 'secret.json', 'secrets.json', 'credential.json', 'credentials.json', 'password.json', 'password.txt', '*-secret.json', '*-secrets.json', '*-credential.json', '*-credentials.json', '*-password.json', '*-password.txt', 'api-key.json', 'api-key.txt', 'apikey.json', 'apikey.txt', 'private-key.pem', '*.key', 'id_rsa', 'id_ed25519', '*.log', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm')
    $robocopyArgs = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($directory in $excludedDirectories) { $robocopyArgs += @('/XD', (Join-Path $Source $directory)) }
    foreach ($file in $excludedFiles) { $robocopyArgs += @('/XF', $file) }
    & robocopy.exe @robocopyArgs | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) { throw "Release tree copy failed with robocopy exit code $copyExitCode." }
    # robocopy uses 1-7 for successful copy states. Do not leak one of those
    # values as this script's process exit code after the package is verified.
    $global:LASTEXITCODE = 0
}

function Copy-PortableRuntime {
    param([string]$Source, [string]$Destination)

    # Copy the runtime tree as ordinary files. Copy-Item can preserve a source
    # reparse point, which makes Get-ChildItem see the files in staging while
    # ZipFile.CreateFromDirectory omits the linked directory from the archive.
    $robocopyArgs = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy.exe @robocopyArgs | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
        throw "Portable runtime copy failed with robocopy exit code $copyExitCode."
    }
    $global:LASTEXITCODE = 0
}

function Copy-PrivateDataTree {
    param([string]$Source, [string]$Destination)
    $excludedDirectories = @('.cloudflared', 'cloudflared', 'tunnel-credentials', 'browser')
    $excludedFiles = @(
        (Join-Path $Source 'auth\users.json'),
        (Join-Path $Source 'auth\session-secret'),
        (Join-Path $Source 'auth\mcp-token-pepper'),
        'ai-config*.json',
        'smtp-config*.json'
    )
    $robocopyArgs = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/Z', '/XJ', '/R:5', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($directory in $excludedDirectories) { $robocopyArgs += @('/XD', (Join-Path $Source $directory)) }
    foreach ($file in $excludedFiles) { $robocopyArgs += @('/XF', $file) }
    $copyOutput = @(& robocopy.exe @robocopyArgs)
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
        $diagnosticTail = ($copyOutput | Select-Object -Last 40) -join [Environment]::NewLine
        throw "Private data copy failed with robocopy exit code $copyExitCode.$([Environment]::NewLine)$diagnosticTail"
    }
    $global:LASTEXITCODE = 0
}

function Get-PrivateExclusions {
    param([string]$Source)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($relative in @('auth\users.json', 'auth\session-secret', 'auth\mcp-token-pepper')) {
        $path = Join-Path $Source $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $entries.Add([ordered]@{ path = ($relative -replace '\\', '/'); reason = 'machine authentication state' })
        }
    }
    foreach ($pattern in @('ai-config*.json', 'smtp-config*.json')) {
        foreach ($file in Get-ChildItem -LiteralPath $Source -File -Filter $pattern -ErrorAction SilentlyContinue) {
            $entries.Add([ordered]@{ path = $file.Name; reason = 'machine provider credentials and configuration' })
        }
    }
    foreach ($relative in @('.cloudflared', 'cloudflared', 'tunnel-credentials')) {
        $path = Join-Path $Source $relative
        if (Test-Path -LiteralPath $path -PathType Container) {
            $entries.Add([ordered]@{ path = "$relative/"; reason = 'tunnel credentials' })
        }
    }
    $browserPath = Join-Path $Source 'browser'
    if (Test-Path -LiteralPath $browserPath -PathType Container) {
        $entries.Add([ordered]@{ path = 'browser/'; reason = 'machine browser profile, cookies, and authenticated session state' })
    }
    return $entries
}

function Assert-NoEmbeddedPrivateCredentials {
    param([string]$DataRoot)
    foreach ($aiConfigPath in @(Get-ChildItem -LiteralPath $DataRoot -File -Filter 'ai-config*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)) {
        try { $aiConfig = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($aiConfigPath)) } catch { throw "AI configuration is not valid JSON: $aiConfigPath. $($_.Exception.Message)" }
        if ($aiConfig.providers) {
            foreach ($provider in $aiConfig.providers.PSObject.Properties) {
                $apiKeyProperty = $provider.Value.PSObject.Properties['apiKey']
                if ($apiKeyProperty -and -not [string]::IsNullOrWhiteSpace([string]$apiKeyProperty.Value)) {
                    throw 'Private data contains an AI API key. Remove machine credentials before packaging.'
                }
            }
        }
    }

    foreach ($smtpConfigPath in @(Get-ChildItem -LiteralPath $DataRoot -File -Filter 'smtp-config*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)) {
        try { $smtpConfig = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($smtpConfigPath)) } catch { throw "SMTP configuration is not valid JSON: $smtpConfigPath. $($_.Exception.Message)" }
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
    if ($normalized -match '^data/auth/(?:users\.json|session-secret|mcp-token-pepper)$') { return $true }
    if ($normalized -match '^data/(?:ai-config|smtp-config)[^/]*\.json$') { return $true }
    if ($normalized -match '^data/browser(?:/|$)') { return $true }
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
$requiredRuntimeFiles = @('node\node.exe', 'node\npm.cmd', 'python\python.exe', 'cloudflared\cloudflared.exe', 'browser\chrome.exe')
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

# Stage beside the requested archive. Portable runtimes can exceed 1 GB, and
# cross-drive staging is both slower and more likely to leave an incomplete
# runtime tree before archive creation on constrained system drives.
$stageParent = Join-Path $outputParent '.package-staging'
if (-not (Test-Path -LiteralPath $stageParent -PathType Container)) {
    New-Item -ItemType Directory -Path $stageParent -Force | Out-Null
}
$stage = Join-Path $stageParent ("hegelsalon-release-" + [guid]::NewGuid().ToString('N'))
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
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'start-windows.cmd') -PathType Leaf)) {
        throw 'Release staging is missing start-windows.cmd.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'start-production-windows.cmd') -PathType Leaf)) {
        throw 'Release staging is missing start-production-windows.cmd.'
    }
    if (-not $OmitNodeModules) {
        Copy-Item -LiteralPath (Join-Path $root 'node_modules') -Destination (Join-Path $stage 'node_modules') -Recurse -Force
    }
    Copy-PortableRuntime -Source $runtimeSource -Destination (Join-Path $stage 'runtime')
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
        $stageCopilotDatabase = Join-Path $stageData 'copilot\copilot-state.sqlite'
        $revocationScript = Join-Path $root 'scripts\revoke-mcp-grants-after-restore.mjs'
        $portableNode = Join-Path $runtimeSource 'node\node.exe'
        $revocationResult = @(& $portableNode $revocationScript --database $stageCopilotDatabase 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Staged MCP Grant revocation failed: $($revocationResult -join [Environment]::NewLine)" }
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
            rawDatasetRecordsUnmodified = $true
            machineCredentialFilesExcluded = @('data/auth/users.json', 'data/auth/session-secret', 'data/auth/mcp-token-pepper', 'data/ai-config*.json', 'data/smtp-config*.json', 'data/browser/')
            activeMcpGrantsRevoked = $true
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
            'The 715 cards, 715 notes, job artifacts, and workflow state are copied without content redaction.',
            'Administrator accounts, session secrets, MCP token pepper, browser profile/cookies, AI/SMTP machine configuration, environment files, tunnel tokens, certificates, and credential files are excluded.',
            'Any MCP Grant copied in the application database is revoked during packaging and must be reissued on the target machine.',
            'Node.js, Python, cloudflared, Chromium, and application dependencies are bundled for a Windows machine with no developer runtime installed.',
            'On a new computer, launch the managed browser once and sign in there; the browser session is intentionally created on that machine.',
            'Use the clean package for a public repository or public release.'
        ) | Set-Content -LiteralPath (Join-Path $stage 'PRIVATE-BUNDLE-NOT-FOR-GITHUB.txt') -Encoding UTF8
    } else {
        [ordered]@{
            schemaVersion = 1
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            includesRawData = $false
            rawDatasetRecordsUnmodified = $false
            machineCredentialFilesExcluded = @('data/', 'data/auth/users.json', 'data/auth/session-secret', 'data/auth/mcp-token-pepper', 'data/ai-config*.json', 'data/smtp-config*.json', 'data/browser/')
            activeMcpGrantsRevoked = $true
            dataSource = $null
            datasetTaskId = $null
            cards = [ordered]@{ path = $null; count = 0 }
            notes = [ordered]@{ path = $null; count = 0 }
            restoredWorkflow = [ordered]@{ taskId = $null; path = $null; present = $false }
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'PORTABLE_DATASET.json') -Encoding UTF8
        Add-Content -LiteralPath (Join-Path $stage 'PORTABLE_DATASET.json') -Value ''
        [ordered]@{
            schemaVersion = 1
            excluded = @(
                [ordered]@{ path = 'data/'; reason = 'all runtime and raw application data is excluded from the public release' },
                [ordered]@{ path = '.env and production.env.local'; reason = 'machine environment and secrets' },
                [ordered]@{ path = 'browser profiles and cookies'; reason = 'machine browser authentication state' },
                [ordered]@{ path = 'tunnel credentials'; reason = 'machine tunnel authentication state' }
            )
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'PRIVATE_EXCLUSIONS.json') -Encoding UTF8
        Add-Content -LiteralPath (Join-Path $stage 'PRIVATE_EXCLUSIONS.json') -Value ''
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        application = 'xiaohongshu-relay-scraper-ui'
        integrity = 'Verify the complete archive with the separately reported SHA-256.'
        publicHost = 'relay.hegelsalon.com'
        originPort = 4327
        publicMcpHost = 'mcp.hegelsalon.com'
        mcpOriginPort = 4328
        publicMcpEndpoint = 'https://mcp.hegelsalon.com/mcp'
        includesNodeModules = (Test-Path -LiteralPath (Join-Path $stage 'node_modules') -PathType Container)
        includesPortableRuntime = ($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stage "runtime\$_") -PathType Leaf) }).Count -eq 0
        includesRawData = [bool]$IncludeData
        dataSource = $dataSourceLabel
        excluded = if ($IncludeData) { @('.git', '.runtime', 'data/auth/users.json', 'data/auth/session-secret', 'data/auth/mcp-token-pepper', 'data/ai-config*.json', 'data/smtp-config*.json', 'data/browser', '.env and .env.* except *.example', '*.token', 'cert.pem', 'tunnel credentials') } else { @('.git', '.runtime', 'data', 'artifacts', 'output', 'profiles', '.env and .env.* except *.example', '*.token', 'cert.pem', 'tunnel credentials') }
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
        $requiredArchiveEntries = @(
            'PORTABLE_MANIFEST.json',
            'PORTABLE_DATASET.json',
            'PRIVATE_EXCLUSIONS.json',
            'start-windows.cmd',
            'start-mcp.cmd',
            'mcp-stdio.cmd',
            'verify-mcp.cmd',
            'start-production-windows.cmd',
            'MCP_PACKAGE_INFO.json',
            'config/mcp-client.example.json',
            'docs/PUBLIC_RELEASE_MCP_GUIDE.md',
            'runtime/node/node.exe',
            'runtime/node/npm.cmd',
            'runtime/python/python.exe',
            'runtime/cloudflared/cloudflared.exe',
            'runtime/browser/chrome.exe',
            'scripts/verify-mcp-production.mjs',
            'scripts/verify-mcp-public-production.ps1',
            'scripts/verify-mcp-public-showcase.mjs',
            'scripts/verify-public-package-mcp.ps1',
            'scripts/revoke-mcp-grants-after-restore.mjs',
            'server/mcp-access-service.mjs',
            'server/mcp-http-server.mjs',
            'server/mcp-management-http.mjs',
            'server/mcp-public-showcase.mjs',
            'src/McpAccessPanel.tsx'
        )
        foreach ($requiredEntry in $requiredArchiveEntries) {
            if (-not ($names -contains $requiredEntry)) { throw "Archive is missing required release metadata: $requiredEntry" }
        }
        foreach ($name in $names) {
            if (Test-ForbiddenReleasePath -RelativePath $name -AllowData ([bool]$IncludeData)) {
                throw "Archive contains a forbidden secret or runtime path: $name"
            }
        }
        if ($IncludeData) {
            foreach ($requiredEntry in @('PRIVATE-BUNDLE-NOT-FOR-GITHUB.txt', "data/$($cardsRelativePath -replace '\\', '/')", "data/$($notesRelativePath -replace '\\', '/')", "data/$($workflowStateRelativePath -replace '\\', '/')")) {
                if (-not ($names -contains $requiredEntry)) { throw "Private archive is missing required entry: $requiredEntry" }
            }
        } elseif ($names | Where-Object { $_ -match '^data(?:/|$)' }) {
            throw 'Clean archive contains a data path.'
        }

        $buffer = New-Object byte[] 131072
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $stream = $entry.Open()
            try {
                while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { }
            } finally {
                $stream.Dispose()
            }
        }
    } finally { $archive.Dispose() }
    $hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumPath = "$OutputPath.sha256"
    $checksumLine = "$hash  $([IO.Path]::GetFileName($OutputPath))`r`n"
    [IO.File]::WriteAllText($checksumPath, $checksumLine, [Text.Encoding]::ASCII)
    Write-Host "Production package created: $OutputPath"
    Write-Host "Archive SHA-256: $hash"
    Write-Host "Archive checksum file: $checksumPath"
    Write-Host "Node dependencies included: $(-not $OmitNodeModules)"
    Write-Host "Portable runtime included: $([bool]$PortableRuntimeRoot)"
    Write-Host "Raw application data included: $([bool]$IncludeData)"
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# A successful PowerShell script must not inherit robocopy's successful
# nonzero status code when callers invoke it from cmd.exe or another shell.
$global:LASTEXITCODE = 0
