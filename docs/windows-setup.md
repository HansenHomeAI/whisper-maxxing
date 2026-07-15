# Windows whisper.cpp setup

The Electron app uses the upstream `whisper-server.exe` and `whisper-cli.exe` programs.
Run the bootstrap from a PowerShell prompt on Windows 10 or 11 after installing Git, CMake,
and Visual Studio 2022 Build Tools with the **Desktop development with C++** workload.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-whisper-windows.ps1
```

By default, the script clones or updates whisper.cpp under
`%LOCALAPPDATA%\WhisperDictation\whisper.cpp`, configures a Release build, builds only the
server and CLI, and downloads the `small.en` model. The last output line is compact JSON
containing the resolved checkout, binary, and model paths for installer automation.

To choose another checkout or use `large-v3` as the active model:

```powershell
$env:WHISPER_CPP_ROOT = 'D:\src\whisper.cpp'
$env:WHISPER_MODEL = 'large-v3'
.\scripts\setup-whisper-windows.ps1
```

`WHISPER_CPP_ROOT` and `WHISPER_MODEL` are also available as `-WhisperCppRoot` and `-Model`
arguments; explicit arguments take precedence over environment variables. Supported model
names are `small.en` and `large-v3`. The script always installs `small.en`; selecting
`large-v3`, or passing `-DownloadLargeV3`, also installs the larger robust model.

Validate an existing checkout without cloning, updating, building, or downloading:

```powershell
.\scripts\setup-whisper-windows.ps1 `
  -WhisperCppRoot 'D:\src\whisper.cpp' `
  -DownloadLargeV3 `
  -CheckOnly
```

`-CheckOnly` fails if either executable, `small.en`, or a requested `large-v3` model is
missing. The build supports the standard CMake multi-config
`build\bin\Release\*.exe` layout and the single-config `build\bin\*.exe` layout.

To run the bootstrap tests, install Pester 5 and invoke the immutable success command:

```powershell
Install-Module Pester -MinimumVersion 5.0 -Scope CurrentUser
Invoke-Pester -Path scripts/setup-whisper-windows.Tests.ps1 -Output Detailed
```
