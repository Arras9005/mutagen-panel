import { run } from "./mutagen.js";
import { shellQuote } from "./pull.js";

export interface RemoteEntry {
  name: string;
  type: "dir" | "file" | "link";
  size: number;
  mtime: string;
}

export interface RemoteListing {
  ok: boolean;
  /** 失败原因。 */
  out: string;
  /** 实际所在的绝对路径(`~`、相对路径会被解析成绝对路径)。 */
  path: string;
  entries: RemoteEntry[];
  /** 条目太多被截断。 */
  truncated: boolean;
}

export const MAX_ENTRIES = 3000;

/**
 * 生成在服务器上执行的只读命令:先 cd 再 pwd,再 ls -l。
 * 路径用单引号保护;`~`、`~/xxx` 展开成 $HOME;`--` 防止以 - 开头的路径被当成选项。
 */
export function buildListCommand(path: string): string {
  let target: string;
  if (path === "~" || path === "") target = `"$HOME"`;
  else if (path.startsWith("~/")) target = `"$HOME"/${shellQuote(path.slice(2))}`;
  else target = shellQuote(path);
  return `cd -- ${target} && pwd && LC_ALL=C ls -lA -p --time-style=long-iso -- . | head -n ${MAX_ENTRIES + 2}`;
}

const LINE = /^([-dlbcps])[rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s(.+)$/;

/** 解析 `pwd` + `ls -lAp` 的输出;目录在前、再按名称排序。 */
export function parseListing(stdout: string): { path: string; entries: RemoteEntry[]; truncated: boolean } {
  const lines = stdout.split(/\r?\n/);
  const path = (lines.shift() ?? "").trim();
  const entries: RemoteEntry[] = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match) continue;
    const kind = match[1];
    let name = match[4] ?? "";
    let type: RemoteEntry["type"] = kind === "d" ? "dir" : kind === "l" ? "link" : "file";
    if (kind === "l") name = name.split(" -> ")[0] ?? name;
    if (name.endsWith("/")) {
      name = name.slice(0, -1);
      type = "dir";
    }
    if (kind !== "-" && kind !== "d" && kind !== "l") continue; // 设备、管道、套接字不展示
    entries.push({ name, type, size: Number(match[2]), mtime: match[3] ?? "" });
  }
  const truncated = entries.length > MAX_ENTRIES;
  entries.splice(MAX_ENTRIES);
  entries.sort((a, b) => {
    const rank = (e: RemoteEntry): number => (e.type === "file" ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" });
  });
  return { path, entries, truncated };
}

/** 通过 ssh 列出服务器目录。host 必须由调用方校验为已知别名。 */
export async function listRemote(host: string, path: string): Promise<RemoteListing> {
  const failed = (out: string): RemoteListing => ({ ok: false, out, path, entries: [], truncated: false });
  if (host === "" || host.startsWith("-")) return failed("服务器别名不合法。");
  if (path.length > 4096 || /[\0\r\n]/.test(path)) return failed("路径不合法。");
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, buildListCommand(path)], 25_000);
  if (result.code === -1) return failed(result.out);
  const first = result.stdout.split(/\r?\n/)[0] ?? "";
  if (!first.startsWith("/")) {
    // cd 失败时 stdout 为空,原因在 stderr
    const reason = result.out.replace(/^bash: line \d+: /, "").trim();
    return failed(reason || "无法读取该目录(目录不存在、没有权限,或 SSH 连接失败)。");
  }
  return { ok: true, out: "", ...parseListing(result.stdout) };
}
