import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

/**
 * 本地文件夹选择器的后端:浏览、新建、删除文件夹。网页拿不到系统的文件夹选择框,所以由面板在本机读目录。
 * 只在本机(127.0.0.1 + 令牌)用;只列文件夹,不读文件内容;删除只删「空文件夹」,并且不删盘符/根目录和用户主目录。
 */
export interface LocalRoot {
  name: string;
  path: string;
}

export interface LocalListing {
  ok: boolean;
  out: string;
  /** 当前目录;空串表示「根列表」(Windows 的盘符列表) */
  path: string;
  /** 上一级;null 表示已经在最顶上 */
  parent: string | null;
  entries: Array<{ name: string }>;
  /** 快捷入口:主目录、桌面、(Windows)各盘符 */
  roots: LocalRoot[];
  truncated: boolean;
}

const MAX_ENTRIES = 2000;
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const isWin = (platform: NodeJS.Platform = process.platform): boolean => platform === "win32";

export function listRoots(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync, home: string = homedir()): LocalRoot[] {
  const pjoin = isWin(platform) ? win32.join : posix.join;
  const roots: LocalRoot[] = [{ name: "主目录", path: home }];
  for (const name of ["Desktop", "桌面", "Documents", "Downloads"]) {
    const path = pjoin(home, name);
    if (exists(path) && !roots.some((r) => r.path === path)) roots.push({ name: name === "Desktop" || name === "桌面" ? "桌面" : name === "Documents" ? "文档" : "下载", path });
  }
  if (isWin(platform)) {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (exists(drive)) roots.push({ name: `${String.fromCharCode(code)} 盘`, path: drive });
    }
  } else {
    roots.push({ name: "根目录 /", path: "/" });
  }
  return roots;
}

function normalize(path: string): string {
  return isWin() ? win32.normalize(path) : resolve(path);
}

/** 上一级:盘符根目录的上一级是「盘符列表」(空串),Unix 的 / 没有上一级。 */
export function parentOf(path: string): string | null {
  if (path === "") return null;
  const up = isWin() ? win32.dirname(path) : dirname(path);
  if (up === path) return isWin() ? "" : null;
  return up;
}

export function listLocal(rawPath: string): LocalListing {
  const roots = listRoots();
  const empty = (path: string, out: string): LocalListing => ({ ok: false, out, path, parent: parentOf(path), entries: [], roots, truncated: false });
  const wanted = rawPath.trim();
  if (wanted === "" && isWin()) return { ok: true, out: "", path: "", parent: null, entries: roots.filter((r) => /^[A-Z]:\\$/.test(r.path)).map((r) => ({ name: r.path })), roots, truncated: false };
  const path = wanted === "" ? homedir() : wanted;
  if (!isAbsolute(path) && !(isWin() && win32.isAbsolute(path))) return empty(path, "请填写完整路径(从盘符或 / 开始)。");
  const full = normalize(path);
  let isDir = false;
  try {
    isDir = statSync(full).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return empty(full, `文件夹不存在:${full}`);
  let names: string[];
  try {
    names = readdirSync(full, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch (error) {
    return empty(full, `读取不了这个文件夹:${(error as Error).message}`);
  }
  names.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" }));
  const truncated = names.length > MAX_ENTRIES;
  return { ok: true, out: "", path: full, parent: parentOf(full), entries: names.slice(0, MAX_ENTRIES).map((name) => ({ name })), roots, truncated };
}

export function validFolderName(name: string): string | null {
  const n = name.trim();
  if (n === "" || n.length > 100) return "文件夹名不能为空,也不能超过 100 个字符。";
  if (n === "." || n === ".." || BAD_NAME.test(n)) return "文件夹名里不能有 \\ / : * ? \" < > | 这些字符。";
  if (/[. ]$/.test(name) || /^ /.test(name)) return "文件夹名不能以空格开头,也不能以空格或点结尾。";
  if (RESERVED.test(n)) return "这是系统保留的名字,换一个。";
  return null;
}

export interface FolderResult {
  ok: boolean;
  out: string;
  path?: string;
}

export function makeLocalFolder(parent: string, name: string): FolderResult {
  const bad = validFolderName(name);
  if (bad) return { ok: false, out: bad };
  if (!isAbsolute(parent) && !(isWin() && win32.isAbsolute(parent))) return { ok: false, out: "请先进入一个文件夹再新建。" };
  const base = normalize(parent);
  const target = isWin() ? win32.join(base, name.trim()) : join(base, name.trim());
  try {
    if (!statSync(base).isDirectory()) return { ok: false, out: `不是文件夹:${base}` };
    if (existsSync(target)) return { ok: false, out: `已经有同名的文件或文件夹:${name.trim()}` };
    mkdirSync(target);
  } catch (error) {
    return { ok: false, out: `新建失败:${(error as Error).message}` };
  }
  return { ok: true, out: "", path: target };
}

/** 只删空文件夹。盘符/根目录、用户主目录不删。 */
export function removeLocalFolder(rawPath: string, home: string = homedir()): FolderResult {
  if (!isAbsolute(rawPath) && !(isWin() && win32.isAbsolute(rawPath))) return { ok: false, out: "路径不合法。" };
  const path = normalize(rawPath);
  if (parentOf(path) === null || parentOf(path) === "" || path === normalize(home)) return { ok: false, out: "不能删除根目录、盘符或用户主目录。" };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, out: `不是文件夹:${path}` };
    if (readdirSync(path).length > 0) return { ok: false, out: "这个文件夹不是空的。为了安全,只能删除空文件夹;里面的东西请先在文件管理器里处理。" };
    rmdirSync(path);
  } catch (error) {
    return { ok: false, out: `删除失败:${(error as Error).message}` };
  }
  return { ok: true, out: "", path };
}
