import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, stat } from "node:fs/promises";
import path from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const helperPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "bin",
    "whisper-mac-capture",
  );
  const helperStat = await stat(helperPath);
  if (!helperStat.isFile()) {
    throw new Error(`Bundled native capture helper is not a file: ${helperPath}`);
  }

  await chmod(helperPath, 0o755);
  await access(helperPath, constants.X_OK);
  execFileSync(
    "codesign",
    ["--force", "--sign", "-", "--timestamp=none", helperPath],
    { stdio: "inherit" },
  );
  execFileSync(
    "codesign",
    ["--verify", "--strict", "--verbose=2", helperPath],
    { stdio: "inherit" },
  );
}
