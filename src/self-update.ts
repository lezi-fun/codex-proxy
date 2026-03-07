/**
 * Proxy self-update — checks for new commits on GitHub and applies via git pull.
 * Only works in CLI mode (where .git exists). Docker/Electron show manual instructions.
 */

import { execFile, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { promisify } from "util";
import { isEmbedded } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ProxyInfo {
  version: string;
  commit: string | null;
}

export interface ProxySelfUpdateResult {
  commitsBehind: number;
  currentCommit: string | null;
  latestCommit: string | null;
}

let _proxyUpdateInProgress = false;
let _gitAvailable: boolean | null = null;

/** Read proxy version from package.json + current git commit hash. */
export function getProxyInfo(): ProxyInfo {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version ?? "unknown";
  } catch { /* ignore */ }

  let commit: string | null = null;
  if (canSelfUpdate()) {
    try {
      const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf-8",
        timeout: 5000,
      });
      commit = out.trim() || null;
    } catch { /* ignore */ }
  }

  return { version, commit };
}

/** Whether this environment supports git-based self-update. */
export function canSelfUpdate(): boolean {
  if (isEmbedded()) return false;
  if (_gitAvailable !== null) return _gitAvailable;

  // Check .git directory exists
  if (!existsSync(resolve(process.cwd(), ".git"))) {
    _gitAvailable = false;
    return false;
  }

  // Check git command is available
  try {
    execFileSync("git", ["--version"], {
      cwd: process.cwd(),
      timeout: 5000,
      stdio: "ignore",
    });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }

  return _gitAvailable;
}

/** Whether a proxy self-update is currently in progress. */
export function isProxyUpdateInProgress(): boolean {
  return _proxyUpdateInProgress;
}

/** Fetch latest from origin and check how many commits behind. */
export async function checkProxySelfUpdate(): Promise<ProxySelfUpdateResult> {
  const cwd = process.cwd();

  // Get current commit
  let currentCommit: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 });
    currentCommit = stdout.trim() || null;
  } catch { /* ignore */ }

  // Fetch latest
  try {
    await execFileAsync("git", ["fetch", "origin", "master", "--quiet"], { cwd, timeout: 30000 });
  } catch (err) {
    console.warn("[SelfUpdate] git fetch failed:", err instanceof Error ? err.message : err);
    return { commitsBehind: 0, currentCommit, latestCommit: currentCommit };
  }

  // Count commits behind
  let commitsBehind = 0;
  let latestCommit: string | null = null;
  try {
    const { stdout: countOut } = await execFileAsync(
      "git", ["rev-list", "HEAD..origin/master", "--count"], { cwd, timeout: 5000 },
    );
    commitsBehind = parseInt(countOut.trim(), 10) || 0;

    const { stdout: latestOut } = await execFileAsync(
      "git", ["rev-parse", "--short", "origin/master"], { cwd, timeout: 5000 },
    );
    latestCommit = latestOut.trim() || null;
  } catch { /* ignore */ }

  return { commitsBehind, currentCommit, latestCommit };
}

/**
 * Apply proxy self-update: git pull + npm install + npm run build.
 * Runs in background. Returns immediately; check isProxyUpdateInProgress() for status.
 */
export async function applyProxySelfUpdate(): Promise<{ started: boolean; error?: string }> {
  if (_proxyUpdateInProgress) {
    return { started: false, error: "Update already in progress" };
  }

  _proxyUpdateInProgress = true;
  const cwd = process.cwd();

  try {
    console.log("[SelfUpdate] Pulling latest code...");
    await execFileAsync("git", ["pull", "origin", "master"], { cwd, timeout: 60000 });

    console.log("[SelfUpdate] Installing dependencies...");
    await execFileAsync("npm", ["install"], { cwd, timeout: 120000, shell: true });

    console.log("[SelfUpdate] Building...");
    await execFileAsync("npm", ["run", "build"], { cwd, timeout: 120000, shell: true });

    console.log("[SelfUpdate] Update complete. Server restart required.");
    _proxyUpdateInProgress = false;
    return { started: true };
  } catch (err) {
    _proxyUpdateInProgress = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SelfUpdate] Update failed:", msg);
    return { started: false, error: msg };
  }
}
