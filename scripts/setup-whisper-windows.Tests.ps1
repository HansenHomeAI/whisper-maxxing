BeforeAll {
    $script:SetupScript = Join-Path $PSScriptRoot 'setup-whisper-windows.ps1'
    . $script:SetupScript
}

Describe 'setup-whisper-windows argument resolution' {
    BeforeEach {
        $env:WHISPER_CPP_ROOT = $null
        $env:WHISPER_MODEL = $null
    }

    It 'prefers the root argument over the environment' {
        $env:WHISPER_CPP_ROOT = Join-Path $TestDrive 'environment-root'
        $expected = [System.IO.Path]::GetFullPath((Join-Path $TestDrive 'argument-root'))

        Resolve-WhisperCppRoot (Join-Path $TestDrive 'argument-root') | Should -Be $expected
    }

    It 'uses WHISPER_CPP_ROOT when no root argument is given' {
        $env:WHISPER_CPP_ROOT = Join-Path $TestDrive 'environment-root'

        Resolve-WhisperCppRoot | Should -Be ([System.IO.Path]::GetFullPath($env:WHISPER_CPP_ROOT))
    }

    It 'prefers the model argument and honors WHISPER_MODEL' {
        $env:WHISPER_MODEL = 'large-v3'

        Resolve-ModelName | Should -Be 'large-v3'
        Resolve-ModelName 'small.en' | Should -Be 'small.en'
    }

    It 'rejects an invalid WHISPER_MODEL override' {
        $env:WHISPER_MODEL = 'tiny.en'

        { Resolve-ModelName } | Should -Throw "Unsupported Whisper model 'tiny.en'.*"
    }
}

Describe 'setup-whisper-windows path resolution' {
    It 'resolves multi-config Release binaries' {
        $root = Join-Path $TestDrive 'release-layout'
        $bin = Join-Path $root 'build\bin\Release'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $bin 'whisper-server.exe') -Value 'server'

        Resolve-WhisperBinary -Root $root -Name 'whisper-server.exe' |
            Should -Be ([System.IO.Path]::GetFullPath((Join-Path $bin 'whisper-server.exe')))
    }

    It 'falls back to the single-config bin directory' {
        $root = Join-Path $TestDrive 'single-layout'
        $bin = Join-Path $root 'build\bin'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $bin 'whisper-cli.exe') -Value 'cli'

        Resolve-WhisperBinary -Root $root -Name 'whisper-cli.exe' |
            Should -Be ([System.IO.Path]::GetFullPath((Join-Path $bin 'whisper-cli.exe')))
    }

    It 'fails clearly when an expected binary is absent' {
        $root = Join-Path $TestDrive 'missing-binary'
        New-Item -ItemType Directory -Path $root -Force | Out-Null

        { Resolve-WhisperBinary -Root $root -Name 'whisper-cli.exe' } |
            Should -Throw '*Unable to find whisper-cli.exe*'
    }

    It 'rejects an empty binary left by an interrupted build' {
        $root = Join-Path $TestDrive 'empty-binary'
        $bin = Join-Path $root 'build\bin\Release'
        New-Item -ItemType Directory -Path $bin -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $bin 'whisper-server.exe') | Out-Null

        { Resolve-WhisperBinary -Root $root -Name 'whisper-server.exe' } |
            Should -Throw '*Unable to find whisper-server.exe*'
    }
}

Describe 'setup-whisper-windows orchestration' {
    BeforeEach {
        $env:WHISPER_CPP_ROOT = $null
        $env:WHISPER_MODEL = $null
        $script:Root = Join-Path $TestDrive 'whisper.cpp'
        $script:ReleaseBin = Join-Path $script:Root 'build\bin\Release'
        $script:Models = Join-Path $script:Root 'models'
        New-Item -ItemType Directory -Path $script:ReleaseBin -Force | Out-Null
        New-Item -ItemType Directory -Path $script:Models -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:ReleaseBin 'whisper-server.exe') -Value 'server'
        Set-Content -LiteralPath (Join-Path $script:ReleaseBin 'whisper-cli.exe') -Value 'cli'
        Set-Content -LiteralPath (Join-Path $script:Models 'ggml-small.en.bin') -Value 'small model'
    }

    It 'runs the source sync and mocked build before resolving output' {
        Mock Sync-WhisperSource {}
        Mock Invoke-WhisperBuild {}
        Mock Install-WhisperModel {}

        $result = Invoke-WhisperWindowsSetup -RequestedRoot $script:Root

        Should -Invoke Sync-WhisperSource -Times 1 -Exactly -ParameterFilter { $Root -eq $script:Root }
        Should -Invoke Invoke-WhisperBuild -Times 1 -Exactly -ParameterFilter { $Root -eq $script:Root }
        Should -Invoke Install-WhisperModel -Times 1 -Exactly -ParameterFilter { $Name -eq 'small.en' }
        $result.model | Should -Be 'small.en'
        $result.serverPath | Should -Be ([System.IO.Path]::GetFullPath((Join-Path $script:ReleaseBin 'whisper-server.exe')))
        $result.robustModelPath | Should -BeNullOrEmpty
    }

    It 'keeps noisy orchestration output out of the JSON result' {
        Mock Sync-WhisperSource { 'git output' }
        Mock Invoke-WhisperBuild { 'cmake output' }
        Mock Install-WhisperModel { 'download output' }

        $output = @(Invoke-WhisperWindowsSetup -RequestedRoot $script:Root)
        $json = $output | ConvertTo-Json -Compress
        $parsed = $json | ConvertFrom-Json

        $output.Count | Should -Be 1
        $json | Should -Match '^\{'
        $parsed.whisperCppRoot | Should -Be ([System.IO.Path]::GetFullPath($script:Root))
        $parsed.serverPath | Should -Match 'whisper-server\.exe$'
    }

    It 'downloads and selects large-v3 when requested by the environment' {
        $env:WHISPER_MODEL = 'large-v3'
        Set-Content -LiteralPath (Join-Path $script:Models 'ggml-large-v3.bin') -Value 'large model'
        Mock Sync-WhisperSource {}
        Mock Invoke-WhisperBuild {}
        Mock Install-WhisperModel {}

        $result = Invoke-WhisperWindowsSetup -RequestedRoot $script:Root

        Should -Invoke Install-WhisperModel -Times 1 -Exactly -ParameterFilter { $Name -eq 'small.en' }
        Should -Invoke Install-WhisperModel -Times 1 -Exactly -ParameterFilter { $Name -eq 'large-v3' }
        $result.model | Should -Be 'large-v3'
        $result.modelPath | Should -Be ([System.IO.Path]::GetFullPath((Join-Path $script:Models 'ggml-large-v3.bin')))
        $result.robustModelPath | Should -Be $result.modelPath
    }

    It 'does not sync, build, or download in CheckOnly mode' {
        Mock Sync-WhisperSource { throw 'must not run' }
        Mock Invoke-WhisperBuild { throw 'must not run' }
        Mock Install-WhisperModel { throw 'must not run' }

        $result = Invoke-WhisperWindowsSetup -RequestedRoot $script:Root -ValidateOnly

        Should -Invoke Sync-WhisperSource -Times 0 -Exactly
        Should -Invoke Invoke-WhisperBuild -Times 0 -Exactly
        Should -Invoke Install-WhisperModel -Times 0 -Exactly
        $result.smallModelPath | Should -Be ([System.IO.Path]::GetFullPath((Join-Path $script:Models 'ggml-small.en.bin')))
    }

    It 'emits machine-readable JSON as the last line in CheckOnly mode' {
        $output = & $script:SetupScript -WhisperCppRoot $script:Root -CheckOnly
        $json = @($output)[-1] | ConvertFrom-Json

        $json.whisperCppRoot | Should -Be ([System.IO.Path]::GetFullPath($script:Root))
        $json.serverPath | Should -Match 'whisper-server\.exe$'
        $json.cliPath | Should -Match 'whisper-cli\.exe$'
        $json.model | Should -Be 'small.en'
        $json.modelPath | Should -Match 'ggml-small\.en\.bin$'
    }

    It 'parses an explicit large-v3 model argument end to end' {
        $env:WHISPER_MODEL = 'small.en'
        Set-Content -LiteralPath (Join-Path $script:Models 'ggml-large-v3.bin') -Value 'large model'

        $output = & $script:SetupScript `
            -WhisperCppRoot $script:Root `
            -Model 'large-v3' `
            -CheckOnly
        $json = @($output)[-1] | ConvertFrom-Json

        $json.model | Should -Be 'large-v3'
        $json.modelPath | Should -Match 'ggml-large-v3\.bin$'
        $json.robustModelPath | Should -Be $json.modelPath
    }
}
