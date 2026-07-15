[CmdletBinding()]
param(
    [string]$WhisperCppRoot,
    [ValidateSet('small.en', 'large-v3')]
    [string]$Model,
    [switch]$DownloadLargeV3,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if ([System.IO.Path]::IsPathRooted($expanded)) {
        return [System.IO.Path]::GetFullPath($expanded)
    }

    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $expanded))
}

function Resolve-WhisperCppRoot {
    param([string]$RequestedRoot)

    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        return Resolve-AbsolutePath $RequestedRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($env:WHISPER_CPP_ROOT)) {
        return Resolve-AbsolutePath $env:WHISPER_CPP_ROOT
    }

    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        $localAppData = Join-Path $HOME 'AppData\Local'
    }
    return Resolve-AbsolutePath (Join-Path $localAppData 'WhisperDictation\whisper.cpp')
}

function Resolve-ModelName {
    param([string]$RequestedModel)

    $resolved = $RequestedModel
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        $resolved = $env:WHISPER_MODEL
    }
    if ([string]::IsNullOrWhiteSpace($resolved)) {
        $resolved = 'small.en'
    }
    if ($resolved -notin @('small.en', 'large-v3')) {
        throw "Unsupported Whisper model '$resolved'. Use 'small.en' or 'large-v3'."
    }
    return $resolved
}

function Test-UsableFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    return (Get-Item -LiteralPath $Path).Length -gt 0
}

function Resolve-WhisperBinary {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [Parameter(Mandatory)]
        [ValidateSet('whisper-server.exe', 'whisper-cli.exe')]
        [string]$Name
    )

    $candidates = @(
        (Join-Path $Root "build\bin\Release\$Name"),
        (Join-Path $Root "build\bin\$Name"),
        (Join-Path $Root "build\Release\$Name")
    )
    foreach ($candidate in $candidates) {
        if (Test-UsableFile $candidate) {
            return Resolve-AbsolutePath $candidate
        }
    }

    throw "Unable to find $Name under '$Root\build'. Run this script without -CheckOnly to build whisper.cpp."
}

function Resolve-WhisperModelPath {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [Parameter(Mandatory)]
        [ValidateSet('small.en', 'large-v3')]
        [string]$Name
    )

    $path = Join-Path $Root "models\ggml-$Name.bin"
    if (-not (Test-UsableFile $path)) {
        throw "Unable to find model '$Name' at '$path'. Run this script without -CheckOnly to download it."
    }
    return Resolve-AbsolutePath $path
}

function Sync-WhisperSource {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    if (Test-Path -LiteralPath (Join-Path $Root '.git') -PathType Container) {
        Write-Host "Updating whisper.cpp at $Root"
        & git -C $Root pull --ff-only | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "git pull failed with exit code $LASTEXITCODE."
        }
        return
    }

    if (Test-Path -LiteralPath $Root) {
        $children = @(Get-ChildItem -LiteralPath $Root -Force)
        if ($children.Count -gt 0) {
            throw "Whisper root '$Root' exists but is not a git checkout."
        }
    }
    else {
        $parent = Split-Path -Parent $Root
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    Write-Host "Cloning whisper.cpp into $Root"
    & git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git $Root | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed with exit code $LASTEXITCODE."
    }
}

function Invoke-WhisperBuild {
    param(
        [Parameter(Mandatory)]
        [string]$Root
    )

    $buildDirectory = Join-Path $Root 'build'
    Write-Host 'Configuring whisper.cpp Release build'
    & cmake -S $Root -B $buildDirectory -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed with exit code $LASTEXITCODE."
    }

    Write-Host 'Building whisper-server.exe and whisper-cli.exe'
    & cmake --build $buildDirectory --config Release --target whisper-server whisper-cli | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "CMake build failed with exit code $LASTEXITCODE."
    }
}

function Install-WhisperModel {
    param(
        [Parameter(Mandatory)]
        [string]$Root,
        [Parameter(Mandatory)]
        [ValidateSet('small.en', 'large-v3')]
        [string]$Name
    )

    $modelPath = Join-Path $Root "models\ggml-$Name.bin"
    if (Test-UsableFile $modelPath) {
        Write-Host "Using existing $Name model"
        return
    }

    $downloadScript = Join-Path $Root 'models\download-ggml-model.cmd'
    if (-not (Test-Path -LiteralPath $downloadScript -PathType Leaf)) {
        throw "Missing whisper.cpp model downloader at '$downloadScript'."
    }

    Write-Host "Downloading $Name model"
    & $downloadScript $Name | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Model download for '$Name' failed with exit code $LASTEXITCODE."
    }
    if (-not (Test-UsableFile $modelPath)) {
        throw "Model downloader completed but '$modelPath' was not created."
    }
}

function Invoke-WhisperWindowsSetup {
    param(
        [string]$RequestedRoot,
        [string]$RequestedModel,
        [switch]$IncludeLargeV3,
        [switch]$ValidateOnly
    )

    $root = Resolve-WhisperCppRoot $RequestedRoot
    $modelName = Resolve-ModelName $RequestedModel

    if ($ValidateOnly) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "Whisper root '$root' does not exist."
        }
    }
    else {
        Sync-WhisperSource $root | Out-Host
        Invoke-WhisperBuild $root | Out-Host
        Install-WhisperModel -Root $root -Name 'small.en' | Out-Host
        if ($IncludeLargeV3 -or $modelName -eq 'large-v3') {
            Install-WhisperModel -Root $root -Name 'large-v3' | Out-Host
        }
    }

    $serverPath = Resolve-WhisperBinary -Root $root -Name 'whisper-server.exe'
    $cliPath = Resolve-WhisperBinary -Root $root -Name 'whisper-cli.exe'
    $smallModelPath = Resolve-WhisperModelPath -Root $root -Name 'small.en'
    $robustModelPath = $null
    if ($IncludeLargeV3 -or $modelName -eq 'large-v3') {
        $robustModelPath = Resolve-WhisperModelPath -Root $root -Name 'large-v3'
    }
    $modelPath = if ($modelName -eq 'large-v3') { $robustModelPath } else { $smallModelPath }

    return [ordered]@{
        whisperCppRoot = $root
        serverPath = $serverPath
        cliPath = $cliPath
        model = $modelName
        modelPath = $modelPath
        smallModelPath = $smallModelPath
        robustModelPath = $robustModelPath
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-WhisperWindowsSetup `
        -RequestedRoot $WhisperCppRoot `
        -RequestedModel $Model `
        -IncludeLargeV3:$DownloadLargeV3 `
        -ValidateOnly:$CheckOnly
    $result | ConvertTo-Json -Compress
}
