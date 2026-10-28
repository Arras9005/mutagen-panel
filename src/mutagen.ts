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
