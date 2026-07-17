import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "../..");
const releaseRoot = path.join(appRoot, "release");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);

const artifacts = await listReleaseEntries(releaseRoot);
const binary = packagedBinary(releaseRoot);
const resources = packagedResources(releaseRoot);
await access(path.join(resources, "bin", "wdctl.mjs"));
const nativeCaptureResult = await verifyUnpackedNativeCapture(resources);
const output = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30_000,
}).trim();
if (!output.includes(packageJson.version)) {
  throw new Error(
    `Packaged binary version mismatch: expected ${packageJson.version}, received ${JSON.stringify(output)}`,
  );
}
const distributableResults = await verifyDistributables({
  artifacts,
  binary,
  nativeCaptureResult,
});

await verifyCompiledSetup();
console.log(`Artifact smoke passed: ${path.relative(appRoot, binary)} --version => ${output}`);
console.log(nativeCaptureResult.message);
for (const result of distributableResults) {
  console.log(result);
}

async function verifyUnpackedNativeCapture(resources) {
  if (process.platform === "darwin") {
    const helper = path.join(resources, "bin", "whisper-mac-capture");
    const digest = await verifyMacHelper(helper);
    return {
      digest,
      message: `Native helper launch passed: ${path.relative(appRoot, helper)} --version => 1`,
    };
  }

  if (process.platform === "win32") {
    const unpackedRoot = path.dirname(resources);
    const forbidden = await findForbiddenWindowsNativeArtifacts(unpackedRoot);
    if (forbidden.length !== 0) {
      throw new Error(
        `Windows package contains macOS native capture artifacts: ${forbidden.join(", ")}`,
      );
    }
    return { message: "Windows unpacked native helper exclusion passed" };
  }

  throw new Error(`Unsupported artifact smoke platform: ${process.platform}`);
}

async function verifyDistributables({ artifacts, binary, nativeCaptureResult }) {
  if (process.platform === "darwin") {
    const dmg = requireSingleArtifact(
      artifacts,
      `-${packageJson.version}-mac-${process.arch}.dmg`,
    );
    const zip = requireSingleArtifact(
      artifacts,
      `-${packageJson.version}-mac-${process.arch}.zip`,
    );
    await Promise.all([
      assertFreshNonemptyArtifact(dmg, binary),
      assertFreshNonemptyArtifact(zip, binary),
    ]);
    return [
      await verifyMacDmg(dmg, nativeCaptureResult.digest),
      await verifyMacZip(zip, nativeCaptureResult.digest),
    ];
  }

  if (process.platform === "win32") {
    const installer = requireSingleArtifact(
      artifacts,
      `-${packageJson.version}-win-${process.arch}.exe`,
    );
    await assertFreshNonemptyArtifact(installer, binary);
    return [await verifyWindowsInstaller(installer, binary)];
  }

  throw new Error(`Unsupported artifact smoke platform: ${process.platform}`);
}

async function verifyMacDmg(dmg, expectedHelperDigest) {
  execFileSync("/usr/bin/hdiutil", ["verify", dmg], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  });
  const mountPoint = await mkdtemp(path.join(os.tmpdir(), "whisper-dmg-smoke-"));
  let mounted = false;
  let verificationError = null;
  let detachError = null;
  try {
    execFileSync(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmg],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    );
    mounted = true;
    const appBundle = await requireSingleRootApp(mountPoint);
    await verifyMacAppBundle(appBundle, expectedHelperDigest);
  } catch (error) {
    verificationError = error;
  }
  if (mounted) {
    try {
      execFileSync("/usr/bin/hdiutil", ["detach", "-force", mountPoint], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      });
    } catch (error) {
      detachError = error;
    }
  }
  await rm(mountPoint, { recursive: true, force: true });
  if (verificationError !== null && detachError !== null) {
    throw new AggregateError(
      [verificationError, detachError],
      `DMG verification and detach both failed: ${dmg}`,
    );
  }
  if (verificationError !== null) {
    throw verificationError;
  }
  if (detachError !== null) {
    throw detachError;
  }
  return `DMG artifact smoke passed: ${path.basename(dmg)} helper --version => 1`;
}

async function verifyMacZip(zip, expectedHelperDigest) {
  execFileSync("/usr/bin/unzip", ["-tqq", zip], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "whisper-zip-smoke-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, temporary], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    });
    const appBundle = await requireSingleRootApp(temporary);
    await verifyMacAppBundle(appBundle, expectedHelperDigest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return `ZIP artifact smoke passed: ${path.basename(zip)} helper --version => 1`;
}

async function verifyMacAppBundle(appBundle, expectedHelperDigest) {
  const resources = path.join(appBundle, "Contents", "Resources");
  await access(path.join(resources, "bin", "wdctl.mjs"));
  const helper = path.join(resources, "bin", "whisper-mac-capture");
  const digest = await verifyMacHelper(helper);
  if (digest !== expectedHelperDigest) {
    throw new Error(
      `Distributable helper differs from unpacked helper: ${helper}`,
    );
  }
  const application = path.join(
    appBundle,
    "Contents",
    "MacOS",
    "Whisper Maxxing",
  );
  const version = launchVersion(application);
  if (!version.includes(packageJson.version)) {
    throw new Error(
      `Distributable application version mismatch: expected ${packageJson.version}, received ${JSON.stringify(version)}`,
    );
  }
}

async function verifyMacHelper(helper) {
  const helperStat = await stat(helper);
  if (!helperStat.isFile()) {
    throw new Error(`Bundled native capture helper is not a file: ${helper}`);
  }
  await access(helper, constants.X_OK);
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", helper], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 30_000,
  });
  const version = launchVersion(helper);
  if (version !== "1") {
    throw new Error(
      `Bundled native capture protocol mismatch: expected 1, received ${JSON.stringify(version)}`,
    );
  }
  return sha256(helper);
}

async function verifyWindowsInstaller(installer, unpackedBinary) {
  const sevenZip = await findSevenZip();
  testArchive(sevenZip, installer);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "whisper-nsis-smoke-"));
  try {
    extractArchive(sevenZip, installer, temporary);
    await extractNestedWindowsArchives(sevenZip, temporary);
    const forbidden = await findForbiddenWindowsNativeArtifacts(temporary);
    if (forbidden.length !== 0) {
      throw new Error(
        `NSIS installer contains macOS native capture artifacts: ${forbidden.join(", ")}`,
      );
    }
    const extractedBinary = await requireExtractedWindowsApplication(temporary);
    const extractedResources = path.join(
      path.dirname(extractedBinary),
      "resources",
    );
    await access(path.join(extractedResources, "bin", "wdctl.mjs"));
    const [unpackedDigest, extractedDigest] = await Promise.all([
      sha256(unpackedBinary),
      sha256(extractedBinary),
    ]);
    if (unpackedDigest !== extractedDigest) {
      throw new Error(
        "NSIS application binary differs from the freshly unpacked application binary.",
      );
    }
    const version = launchVersion(extractedBinary);
    if (!version.includes(packageJson.version)) {
      throw new Error(
        `NSIS application version mismatch: expected ${packageJson.version}, received ${JSON.stringify(version)}`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return `NSIS artifact smoke passed: ${path.basename(installer)} contains no Swift/helper artifacts`;
}

async function requireSingleRootApp(root) {
  const matches = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(root, entry.name));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one root application bundle under ${root}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function requireSingleArtifact(entries, suffix) {
  const matches = entries.filter((entry) => entry.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one artifact ending in ${suffix} under ${releaseRoot}, found ${matches.length}`,
    );
  }
  return path.join(releaseRoot, matches[0]);
}

async function assertFreshNonemptyArtifact(artifact, referenceFile) {
  const [artifactStat, referenceStat] = await Promise.all([
    stat(artifact),
    stat(referenceFile),
  ]);
  if (!artifactStat.isFile() || artifactStat.size < 1_024) {
    throw new Error(`Distributable is empty or not a regular file: ${artifact}`);
  }
  if (artifactStat.mtimeMs + 1_000 < referenceStat.mtimeMs) {
    throw new Error(
      `Distributable predates the unpacked application and may be stale: ${artifact}`,
    );
  }
  const ageMilliseconds = Date.now() - artifactStat.mtimeMs;
  if (ageMilliseconds > 30 * 60 * 1_000 || ageMilliseconds < -60_000) {
    throw new Error(
      `Distributable timestamp is stale or invalid (${Math.round(ageMilliseconds / 1_000)} seconds): ${artifact}`,
    );
  }
}

async function findSevenZip() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter((value) => typeof value === "string" && value.length !== 0);
  const candidates = [
    ...roots.map((root) => path.join(root, "7-Zip", "7z.exe")),
    "C:\\ProgramData\\chocolatey\\bin\\7z.exe",
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  let discovered = [];
  try {
    discovered = execFileSync("where.exe", ["7z.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length !== 0);
  } catch {
    discovered = [];
  }
  for (const candidate of discovered) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Windows distributable smoke requires the preinstalled 7-Zip extractor, but 7z.exe was not found.",
  );
}

function testArchive(sevenZip, archive) {
  execFileSync(sevenZip, ["t", "-bd", "-y", archive], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  });
}

function extractArchive(sevenZip, archive, destination) {
  execFileSync(sevenZip, ["x", "-bd", "-y", `-o${destination}`, archive], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  });
}

async function extractNestedWindowsArchives(sevenZip, root) {
  const processed = new Set();
  let extractionCount = 0;
  while (true) {
    const archives = (await findPaths(root, (entry) => {
      const lowerName = entry.name.toLowerCase();
      return (
        entry.isFile() &&
        (lowerName.endsWith(".7z") || lowerName.endsWith(".zip"))
      );
    })).filter((archive) => !processed.has(archive));
    if (archives.length === 0) {
      return;
    }
    for (const archive of archives) {
      processed.add(archive);
      extractionCount += 1;
      if (extractionCount > 20) {
        throw new Error("NSIS installer contains too many nested archives to inspect safely.");
      }
      testArchive(sevenZip, archive);
      const destination = path.join(root, `nested-${extractionCount}`);
      extractArchive(sevenZip, archive, destination);
    }
  }
}

async function requireExtractedWindowsApplication(root) {
  const candidates = await findPaths(
    root,
    (entry) => entry.isFile() && entry.name.toLowerCase() === "whisper maxxing.exe",
  );
  const applications = [];
  for (const candidate of candidates) {
    if (
      await pathExists(
        path.join(path.dirname(candidate), "resources", "app.asar"),
      )
    ) {
      applications.push(candidate);
    }
  }
  if (applications.length !== 1) {
    throw new Error(
      `Expected exactly one complete application in the NSIS payload, found ${applications.length}`,
    );
  }
  return applications[0];
}

async function findPaths(root, predicate) {
  const matches = [];
  const pending = [root];
  while (pending.length !== 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (predicate(entry)) {
        matches.push(entryPath);
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return matches.sort();
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function launchVersion(executable) {
  return execFileSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function findForbiddenWindowsNativeArtifacts(root) {
  const forbidden = [];
  const pending = [root];
  while (pending.length !== 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      const lowerName = entry.name.toLowerCase();
      if (
        lowerName.includes("whisper-mac-capture") ||
        lowerName.includes("whispermaccapture") ||
        lowerName === "macos-capture" ||
        lowerName === ".build" ||
        lowerName === "package.swift" ||
        lowerName === "package.resolved" ||
        lowerName.endsWith(".swift")
      ) {
        forbidden.push(relative);
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return forbidden.sort();
}

async function verifyCompiledSetup() {
  const { ensureFirstRunConfig, MAC_ACCESSIBILITY_SETTINGS_URL, MAC_MICROPHONE_SETTINGS_URL } =
    await import(
      pathToFileURL(path.join(appRoot, "dist-electron/main/firstRun.js")).href
    );
  const { configureLaunchAtLogin } = await import(
    pathToFileURL(path.join(appRoot, "dist-electron/main/loginItem.js")).href
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "whisper-dist-smoke-"));
  try {
    const configPath = path.join(temporary, "config.json");
    const result = await ensureFirstRunConfig({
      platform: "darwin",
      environment: {
        WHISPER_SERVER_BINARY: "/whisper/server",
        WHISPER_CLI_BINARY: "/whisper/cli",
        WHISPER_MODEL_PATH: "/whisper/model.bin",
      },
      configPath,
      paths: {
        homeDirectory: temporary,
        appDataDirectory: path.join(temporary, "support"),
        documentsDirectory: path.join(temporary, "documents"),
        resourcesDirectory: path.join(temporary, "resources"),
        executablePath: binary,
      },
    });
    if (!result.created || result.config.controlPort !== 44_124 || result.config.whisperServerPort !== 8_179 || result.config.robustWhisperServerPort !== 8_180) {
      throw new Error("First-run config did not use the Electron coexistence defaults.");
    }
    if (
      result.permissionLinks[0] !== MAC_MICROPHONE_SETTINGS_URL ||
      result.permissionLinks[1] !== MAC_ACCESSIBILITY_SETTINGS_URL
    ) {
      throw new Error("First-run config omitted the macOS permission deep-links.");
    }
    const second = await ensureFirstRunConfig({ platform: "darwin", configPath });
    if (second.created) {
      throw new Error("First-run config overwrote an existing config.");
    }

    const windowsConfig = await ensureFirstRunConfig({
      platform: "win32",
      environment: {
        WHISPER_SETUP_JSON: JSON.stringify({
          serverPath: "C:\\Whisper\\whisper-server.exe",
          cliPath: "C:\\Whisper\\whisper-cli.exe",
          smallModelPath: "C:\\Whisper\\ggml-small.en.bin",
          robustModelPath: "C:\\Whisper\\ggml-large-v3.bin",
        }),
      },
      configPath: path.join(temporary, "windows-config.json"),
      paths: {
        homeDirectory: "C:\\Users\\smoke",
        appDataDirectory: "C:\\Users\\smoke\\AppData\\Roaming",
        documentsDirectory: "C:\\Users\\smoke\\Documents",
        resourcesDirectory: "C:\\Program Files\\Whisper Maxxing\\resources",
        executablePath: "C:\\Program Files\\Whisper Maxxing\\Whisper Maxxing.exe",
      },
    });
    if (
      windowsConfig.config.whisperServerBinary !== "C:\\Whisper\\whisper-server.exe" ||
      windowsConfig.config.whisperModelPath !== "C:\\Whisper\\ggml-small.en.bin" ||
      windowsConfig.config.whisperRobustModelPath !== "C:\\Whisper\\ggml-large-v3.bin"
    ) {
      throw new Error("First-run config ignored setup-whisper-windows JSON output.");
    }

    let configured = null;
    configureLaunchAtLogin(
      {
        setLoginItemSettings(settings) {
          configured = settings.openAtLogin;
        },
        getLoginItemSettings() {
          return { openAtLogin: configured };
        },
      },
      { launchAtLogin: false },
      "win32",
    );
    if (configured !== false) {
      throw new Error("Launch-at-login config toggle was ignored.");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listReleaseEntries(root) {
  const { readdir } = await import("node:fs/promises");
  return readdir(root);
}

function packagedBinary(root) {
  if (process.platform === "darwin") {
    const unpacked = process.arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(
      root,
      unpacked,
      "Whisper Maxxing.app",
      "Contents",
      "MacOS",
      "Whisper Maxxing",
    );
  }
  if (process.platform === "win32") {
    return path.join(root, "win-unpacked", "Whisper Maxxing.exe");
  }
  throw new Error(`Unsupported artifact smoke platform: ${process.platform}`);
}

function packagedResources(root) {
  if (process.platform === "darwin") {
    const unpacked = process.arch === "arm64" ? "mac-arm64" : "mac";
    return path.join(
      root,
      unpacked,
      "Whisper Maxxing.app",
      "Contents",
      "Resources",
    );
  }
  if (process.platform === "win32") {
    return path.join(root, "win-unpacked", "resources");
  }
  throw new Error(`Unsupported artifact smoke platform: ${process.platform}`);
}
