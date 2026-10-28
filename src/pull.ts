import { spawn } from "node:child_process";

/** 单引号包裹,内部的单引号写成 '\'' ,让远程 shell 把整段当成一个字面量。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const VCS_DIRS = [".git", ".svn", ".hg", ".bzr", "_darcs"];

/**
 * 把会话的排除规则翻译成 tar 的 --exclude 模式。
 * 打包时成员名都以 ./ 开头:以 / 开头或中间带 / 的规则只匹配根目录下的路径(写成 ./路径),
 * 其余规则像 Mutagen 一样匹配任意层级的同名文件或目录。以 ! 开头的反向规则不支持,忽略。
 */
export function buildExcludes(ignore: string[], ignoreVcs: boolean): string[] {
  const result: string[] = ignoreVcs ? [...VCS_DIRS] : [];
  for (const raw of ignore) {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("!") || pattern.startsWith("#") || /[\r\n\0]/.test(pattern)) continue;
    pattern = pattern.replace(/\/+$/, "");
    if (pattern === "") continue;
    if (pattern.startsWith("/")) pattern = `.${pattern}`;
    else if (pattern.includes("/")) pattern = `./${pattern}`;
    result.push(pattern);
  }
  return result;
}

/** 服务器上执行的打包命令:只读,不改动服务器上的任何文件。 */
export function buildRemoteCommand(remotePath: string, excludes: string[]): string {
  const parts = ["tar", "-c", "-f", "-", ...excludes.map((pattern) => `--exclude=${shellQuote(pattern)}`), "-C", shellQuote(remotePath), "."];
  return parts.join(" ");
}

export interface PullResult {
  ok: boolean;
  out: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 把服务器目录打包传到本地并解压:同名文件被服务器的版本覆盖,本地多出来的文件不会被删除。
 * 本地需要有 tar(Windows 10 以后、macOS、Linux 自带)。
 */
export function pullDirectory(host: string, remotePath: string, local: string, excludes: string[], timeoutMs = 30 * 60_000): Promise<PullResult> {
  return new Promise((resolve) => {
    const ssh = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, buildRemoteCommand(remotePath, excludes)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // 本机解压时再排除一遍:即使服务器上的 tar 没按规则排除,被排除的文件也不会覆盖本地
    const tar = spawn("tar", ["-x", "-v", "-f", "-", "--no-same-owner", ...excludes.map((pattern) => `--exclude=${pattern}`), "-C", local], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let bytes = 0;
    let entries = 0;
    let sshErr = "";
    const tarErr: string[] = [];
    let sshCode: number | null | undefined;
    let tarCode: number | null | undefined;
    let failure = "";
    let finished = false;

    const finish = (): void => {
      if (finished || sshCode === undefined || tarCode === undefined) return;
      finished = true;
      clearTimeout(timer);
      // 服务器上 tar 退出码 1 只表示"读取时文件有变化",数据已传完,不算失败
      const ok = failure === "" && tarCode === 0 && (sshCode === 0 || sshCode === 1);
      if (ok) {
        resolve({ ok: true, out: `已用服务器的文件覆盖本地:处理了 ${entries} 个文件和目录,传输 ${formatBytes(bytes)}。\n本地多出来的文件没有删除。` });
        return;
      }
      const detail = [failure, sshErr.trim(), ...tarErr.slice(-8)].filter(Boolean).join("\n");
      resolve({ ok: false, out: `覆盖没有完成(ssh 退出码 ${sshCode},tar 退出码 ${tarCode}),已处理 ${entries} 项。\n${detail}`.trim() });
    };

    const fail = (message: string): void => {
      if (failure === "") failure = message;
      ssh.kill();
      tar.kill();
    };

    const timer = setTimeout(() => fail(`超过 ${Math.round(timeoutMs / 60_000)} 分钟仍未完成,已中止。`), timeoutMs);

    ssh.on("error", (error) => {
      fail(`无法运行 ssh:${error.message}`);
      sshCode = -1;
      finish();
    });
    tar.on("error", (error) => {
      fail(`无法运行本机的 tar(Windows 需要 10 以上自带的 tar.exe):${error.message}`);
      tarCode = -1;
      finish();
    });
    tar.stdin.on("error", () => undefined);

    ssh.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    ssh.stdout.pipe(tar.stdin);
    ssh.stderr.on("data", (chunk: Buffer) => {
      sshErr = (sshErr + chunk.toString()).slice(-4000);
    });

    // GNU tar 把 -v 的文件列表写到 stdout,bsdtar 写到 stderr 且每行以 "x " 开头
    const countLines = (text: string): void => {
      entries += text.split(/\r?\n/).filter((line) => line !== "").length;
    };
    tar.stdout.on("data", (chunk: Buffer) => countLines(chunk.toString()));
    tar.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line === "") continue;
        if (/^x /.test(line)) entries += 1;
        else tarErr.push(line);
      }
    });

    ssh.on("close", (code) => {
      sshCode = code;
      finish();
    });
    tar.on("close", (code) => {
      tarCode = code;
      finish();
    });
  });
}
