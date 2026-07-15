param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("paste", "undo", "foreground")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WhisperInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    private const uint Keyboard = 1;
    private const uint KeyUp = 2;
    private const ushort Control = 0x11;

    private static INPUT Key(ushort virtualKey, uint flags) {
        return new INPUT {
            type = Keyboard,
            data = new InputUnion {
                keyboard = new KEYBDINPUT { virtualKey = virtualKey, flags = flags }
            }
        };
    }

    public static void Chord(ushort key) {
        INPUT[] inputs = {
            Key(Control, 0),
            Key(key, 0),
            Key(key, KeyUp),
            Key(Control, KeyUp)
        };
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static string ForegroundProcessName() {
        uint processId;
        GetWindowThreadProcessId(GetForegroundWindow(), out processId);
        if (processId == 0) return "";
        return System.Diagnostics.Process.GetProcessById((int)processId).ProcessName;
    }
}
"@

switch ($Action) {
  "paste" { [WhisperInput]::Chord([ushort][char]'V') }
  "undo" { [WhisperInput]::Chord([ushort][char]'Z') }
  "foreground" { [Console]::Out.WriteLine([WhisperInput]::ForegroundProcessName()) }
}
