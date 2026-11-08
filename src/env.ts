import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { run, type RunResult } from "./mutagen.js";

/**
 * 本机 Mutagen 的发现和体检。
 * 面板用配置里的完整路径调用 mutagen,所以 mutagen **不需要**加进 PATH;
 * 找不到时先自动去常见位置找,找到了就改写配置里的路径;找不到或有别的问题,就把该执行的命令写出来。
 * Mutagen 把服务器端的代理程序推给 Linux 服务器时要用 mutagen-agents.tar.gz,它必须和 mutagen 在同一个目录里。
 */
export interface EnvDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
  run: (command: string, args: string[], timeoutMs?: number) => Promise<RunResult>;
}

export const defaultEnvDeps: EnvDeps = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  run,
};

/** 按平台选路径写法(测试里可以在 Linux 上模拟 Windows 路径) */
const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

const exeName = (platform: NodeJS.Platform): string => (platform === "win32" ? "mutagen.exe" : "mutagen");

/** 常见的安装位置(不含 PATH)。 */
export function candidateDirs(d: Pick<EnvDeps, "platform" | "env" | "home">): string[] {
  const { join } = pathFor(d.platform);
  const dirs: string[] = [];
  const home = d.home;
  if (d.platform === "win32") {
    const local = d.env.LOCALAPPDATA;
    dirs.push(join(home, "mutagen"), join(home, "Mutagen"), join(home, "Downloads", "mutagen"), join(home, "scoop", "shims"), join(home, "scoop", "apps", "mutagen", "current"));
    if (local) dirs.push(join(local, "Programs", "mutagen"), join(local, "Mutagen"), join(local, "Microsoft", "WinGet", "Links"));
    for (const base of [d.env.ProgramFiles, d.env["ProgramFiles(x86)"]]) if (base) dirs.push(join(base, "mutagen"));
    if (d.env.ChocolateyInstall) dirs.push(join(d.env.ChocolateyInstall, "bin"));
    dirs.push("C:\\tools\\mutagen", "C:\\mutagen");
  } else if (d.platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", join(home, "mutagen"), join(home, ".local", "bin"), join(home, "bin"));
  } else {
    dirs.push("/usr/local/bin", "/usr/bin", join(home, ".local", "bin"), join(home, "bin"), join(home, "mutagen"), "/opt/mutagen");
  }
  return dirs;
}

/** PATH 里的目录。 */
export function pathDirs(d: Pick<EnvDeps, "platform" | "env">): string[] {
  const raw = d.env.PATH ?? d.env.Path ?? "";
  return raw.split(d.platform === "win32" ? ";" : ":").map((x) => x.trim().replace(/^"|"$/g, "")).filter((x) => x !== "");
}

/** 找一个能运行的 mutagen。configured 已经能运行就不用找;返回找到的完整路径和来源,找不到返回 null。 */
export async function findMutagen(d: EnvDeps, tried: string): Promise<{ path: string; how: string } | null> {
  const { join } = pathFor(d.platform);
  const name = exeName(d.platform);
  const seen = new Set<string>([tried]);
  const sources: Array<[string, string]> = [
    ...pathDirs(d).map((dir): [string, string] => [dir, "PATH"]),
    ...candidateDirs(d).map((dir): [string, string] => [dir, "常见安装位置"]),
  ];
  for (const [dir, how] of sources) {
    const path = join(dir, name);
    if (seen.has(path) || !d.exists(path)) continue;
    seen.add(path);
    const version = await d.run(path, ["version"], 15_000);
    if (version.ok) return { path, how };
  }
  return null;
}

/** mutagen-agents.tar.gz 是否和 mutagen 在一起(符号链接按真实位置再找一次,Homebrew 就是这样装的)。 */
export function agentsBundle(d: Pick<EnvDeps, "exists" | "realpath"> & { platform?: NodeJS.Platform }, mutagenPath: string): string | null {
  const { dirname, join } = pathFor(d.platform ?? process.platform);
  const real = d.realpath(mutagenPath);
  for (const dir of new Set([dirname(mutagenPath), dirname(real), join(dirname(real), "..", "libexec")])) {
    const candidate = join(dir, "mutagen-agents.tar.gz");
    if (d.exists(candidate)) return candidate;
  }
  return null;
}

const RELEASES = "https://github.com/mutagen-io/mutagen/releases";

/** 安装命令(用户自己执行)。版本号写 0.18.1,和面板验证过的一致,想用新版把版本号换掉。 */
export function installCommands(platform: NodeJS.Platform, arch: string): string {
  const goarch = arch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") {
    return [
      "# Windows(PowerShell,复制整段执行;装到你的用户目录,不需要管理员权限):",
      "$v='0.18.1'; $d=\"$env:USERPROFILE\\mutagen\"; New-Item -ItemType Directory -Force $d | Out-Null",
      `Invoke-WebRequest "${RELEASES}/download/v$v/mutagen_windows_${goarch}_v$v.zip" -OutFile "$d\\mutagen.zip"`,
      "Expand-Archive \"$d\\mutagen.zip\" -DestinationPath $d -Force; Remove-Item \"$d\\mutagen.zip\"",
      "# 面板只需要完整路径,下面这行(加入 PATH,以后在任何终端直接敲 mutagen)可选,执行后要重新打开终端:",
      "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + \";$d\", 'User')",
    ].join("\n");
  }
  if (platform === "darwin") {
    return [
      "# macOS(Homebrew,会把 mutagen 和 mutagen-agents.tar.gz 一起装好):",
      "brew install mutagen-io/mutagen/mutagen",
      "# 或者手动:",
      "v=0.18.1; mkdir -p ~/mutagen && cd ~/mutagen",
      `curl -fL -o m.tgz ${RELEASES}/download/v$v/mutagen_darwin_${goarch}_v$v.tar.gz && tar xzf m.tgz && rm m.tgz`,
      "# 加入 PATH(可选,面板只需要完整路径):  echo 'export PATH=\"$PATH:$HOME/mutagen\"' >> ~/.zshrc",
    ].join("\n");
  }
  return [
    "# Linux:",
    "v=0.18.1; mkdir -p ~/mutagen && cd ~/mutagen",
    `curl -fL -o m.tgz ${RELEASES}/download/v$v/mutagen_linux_${goarch}_v$v.tar.gz && tar xzf m.tgz && rm m.tgz`,
    "# 加入 PATH(可选,面板只需要完整路径):  echo 'export PATH=\"$PATH:$HOME/mutagen\"' >> ~/.bashrc",
  ].join("\n");
}

export interface EnvItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EnvReport {
  ok: boolean;
  items: EnvItem[];
  /** 自动找到并应改写进配置的 mutagen 路径(与当前配置不同时才有) */
  fixedPath: string | null;
  /** 给人看的完整说明,含该执行的命令 */
  text: string;
}

/** 体检本机:mutagen 能不能运行(找不到就去找)、代理程序包、ssh、后台服务。 */
export async function diagnose(d: EnvDeps, configured: string): Promise<EnvReport> {
  const items: EnvItem[] = [];
  let fixedPath: string | null = null;
  let path = configured;
  let version = await d.run(path, ["version"], 20_000);
  if (!version.ok && version.code === -1) {
    const found = await findMutagen(d, path);
    if (found) {
      path = found.path;
      fixedPath = found.path;
      version = await d.run(path, ["version"], 20_000);
      items.push({ name: "Mutagen", ok: version.ok, detail: `原来的路径「${configured}」找不到,已在${found.how}找到并改用:${found.path}(${version.out})` });
    } else {
      items.push({ name: "Mutagen", ok: false, detail: `找不到可执行文件「${configured}」,PATH 和常见位置里也没有。` });
    }
  } else {
    items.push({ name: "Mutagen", ok: version.ok, detail: version.out || "(没有输出)" });
  }
  const runnable = version.ok;

  if (runnable) {
    const bundle = agentsBundle(d, path);
    const { dirname } = pathFor(d.platform);
    items.push(bundle
      ? { name: "代理程序包", ok: true, detail: bundle }
      : { name: "代理程序包", ok: false, detail: `${dirname(d.realpath(path))} 里没有 mutagen-agents.tar.gz。没有它,Mutagen 没法把服务器端的代理程序装到 Linux 服务器上(同步会报 agent 相关的错)。请把官方压缩包里的这个文件和 mutagen 放在同一个目录。` });
    const daemon = await d.run(path, ["daemon", "start"], 20_000);
    items.push({ name: "后台服务", ok: daemon.ok, detail: daemon.out || "已运行" });
  }

  const ssh = await d.run("ssh", ["-V"], 10_000);
  items.push({ name: "ssh", ok: ssh.ok, detail: ssh.ok ? ssh.out : "找不到 ssh 命令。Windows 10 以后在「设置 → 应用 → 可选功能」里添加「OpenSSH 客户端」;macOS 和 Linux 自带。" });

  const ok = items.every((i) => i.ok);
  const lines = items.map((i) => `[${i.ok ? "正常" : "有问题"}] ${i.name}: ${i.detail}`);
  if (!items[0]?.ok) {
    lines.push("", "安装 Mutagen(装好后回到面板再点一次「环境检查」,面板会自动找到它;不需要手动改配置):", installCommands(d.platform, d.arch));
  }
  return { ok, items, fixedPath, text: lines.join("\n") };
}
