import type { App } from "electron";

export const DEFAULT_LAUNCH_AT_LOGIN = true;

export interface LaunchAtLoginConfig {
  launchAtLogin?: boolean | null;
}

export function launchAtLoginEnabled(config: LaunchAtLoginConfig): boolean {
  const value = config.launchAtLogin;
  if (value === undefined || value === null) {
    return DEFAULT_LAUNCH_AT_LOGIN;
  }
  if (typeof value !== "boolean") {
    throw new Error("launchAtLogin must be a boolean");
  }
  return value;
}

export function configureLaunchAtLogin(
  electronApp: Pick<App, "setLoginItemSettings" | "getLoginItemSettings">,
  config: LaunchAtLoginConfig,
  platform: NodeJS.Platform = process.platform,
): void {
  const enabled = launchAtLoginEnabled(config);
  electronApp.setLoginItemSettings({
    openAtLogin: enabled,
    ...(platform === "darwin" ? { openAsHidden: true } : {}),
  });

  const effective = electronApp.getLoginItemSettings();
  if (effective.openAtLogin !== enabled) {
    throw new Error(
      `Unable to ${enabled ? "enable" : "disable"} launch at login.`,
    );
  }
}
