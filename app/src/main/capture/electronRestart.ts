export interface ElectronApplicationLifecycle {
  relaunch(): void;
  exit(exitCode?: number): void;
}

export async function restartElectronApplication(
  lifecycle?: ElectronApplicationLifecycle,
): Promise<void> {
  const electronLifecycle =
    lifecycle ?? (await import("electron")).app;
  electronLifecycle.relaunch();
  electronLifecycle.exit(75);
}
