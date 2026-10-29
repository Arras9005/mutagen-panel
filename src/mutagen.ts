import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  /** 进程退出码;可执行文件不存在时为 -1。 */
  code: number;
  stdout: string;
  /** stdout 与 stderr 合并后的文本,用于展示。 */
  out: string;
}

/** 以参数数组执行命令,不经过 shell,避免路径和参数被二次解析。 */
export function run(command: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, code: -1, stdout: "", out: `找不到可执行文件:${command}` });
          return;
        }
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const timedOut = error?.killed ? "\n(命令超时,已终止)" : "";
        resolve({ ok: !error, code, stdout, out: `${stdout}${stderr}`.trim() + timedOut });
      },
    );
  });
}

export async function checkSsh(host: string): Promise<{ ok: boolean; out: string }> {
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "echo ok"], 20_000);
  if (result.stdout.trim() === "ok") {
    return { ok: true, out: `SSH 免密登录正常(${host})。` };
  }
  return {
    ok: false,
    out: `SSH 免密登录失败(${host}):请先在命令行执行 ssh ${host} "echo ok",必须直接输出 ok 且不要密码。\n${result.out}`,
  };
}

export interface ParsedSession {
  status: string;
  paused: boolean;
  alphaConnected: boolean | undefined;
  betaConnected: boolean | undefined;
  progress: string;
  current: string;
  /** 已创建会话实际使用的两端地址(第一个 URL 是服务器端,第二个是本地端)。 */
  alphaUrl: string | undefined;
  betaUrl: string | undefined;
  /** 冲突、传输问题、最近错误等需要提醒的行。 */
  warns: string[];
}

export interface ConflictItem {
  path: string;
  /** 服务器端(alpha)对这个路径做了什么,如"新增文件"、"修改了文件"。没有则为空。 */
  alpha: string;
  /** 本地端(beta)对这个路径做了什么。 */
  beta: string;
}

const KIND = /^(File|Directory|Symbolic link)\b/;

function kindName(side: string): string | null {
  const match = KIND.exec(side.trim());
  if (!match) return null;
  return match[1] === "File" ? "文件" : match[1] === "Directory" ? "目录" : "符号链接";
}

/** 把 `<non-existent> -> File (哈希)` 这样的变化描述翻译成中文。 */
function summarizeChange(description: string): string {
  const [left = "", right = ""] = description.split(" -> ");
  const before = kindName(left);
  const after = kindName(right);
  if (before === null && after !== null) return `新增${after}`;
  if (before !== null && after === null) return `删除了${before}`;
  if (before !== null && after !== null) return before === after ? `修改了${before}` : `${before}变成${after}`;
  return "";
}

/**
 * 从 `mutagen sync list --long` 的输出里取出冲突的文件。
 * 格式:`Conflicts:` 下面每行 `(alpha|beta) 路径 (旧状态 -> 新状态)`,同一路径两端各一行。
 */
export function parseConflicts(text: string): ConflictItem[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*Conflicts:\s*$/.test(line));
  if (start < 0) return [];
  const entry = /^\s*\((alpha|beta)\)\s+(.+?)\s+\(((?:<non-existent>|(?:File|Directory|Symbolic link)\b).*->.*)\)\s*$/;
  const byPath = new Map<string, ConflictItem>();
  for (const line of lines.slice(start + 1)) {
    const match = entry.exec(line);
    if (!match) {
      if (line.trim() === "" || /^\S/.test(line)) break; // 空行或回到顶格(如 Status:)就结束
      continue; // 缩进的其他行(如省略号)跳过
    }
    const [, side, path = "", description = ""] = match;
    const item = byPath.get(path) ?? { path, alpha: "", beta: "" };
    item[side === "alpha" ? "alpha" : "beta"] = summarizeChange(description);
    byPath.set(path, item);
  }
  return [...byPath.values()];
}

function field(block: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.+?)\\s*$`, "m").exec(block);
  return match?.[1] ?? "";
}

/** 解析 `mutagen sync list` 的文本输出,按会话名返回。 */
export function parseList(text: string): Record<string, ParsedSession> {
  const result: Record<string, ParsedSession> = {};
  for (const block of text.split(/^-{10,}\s*$/m)) {
    const name = field(block, "Name");
    if (!name) continue;
    const status = field(block, "Status");
    const connected = [...block.matchAll(/^\s*Connected:\s*(\w+)/gm)].map((m) => m[1] === "Yes");
    const urls = [...block.matchAll(/^\s*URL:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    const warns = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          (/(problems?|conflicts?):\s*\d+/i.test(line) && !/:\s*0$/.test(line)) || /^(conflicts?:|last error)/i.test(line),
      );
    result[name] = {
      status,
      paused: /paused/i.test(status),
      alphaConnected: connected[0],
      betaConnected: connected[1],
      alphaUrl: urls[0],
      betaUrl: urls[1],
      progress: field(block, "Staging progress"),
      current: field(block, "Current file"),
      warns,
    };
  }
  return result;
}

function endpointKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 比较配置里的地址与已创建会话实际使用的地址(忽略斜杠方向、末尾斜杠和大小写)。 */
export function sameEndpoint(configured: string, actual: string | undefined): boolean {
  return actual !== undefined && endpointKey(configured) === endpointKey(actual);
}
