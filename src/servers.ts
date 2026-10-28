import { Client } from "ssh2";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkSsh, run } from "./mutagen.js";
import type { ServerConfig } from "./config.js";

export interface ServerResult {
  ok: boolean;
  out: string;
}

const sshDir = (): string => join(homedir(), ".ssh");
const sshConfigFile = (): string => join(sshDir(), "config");
const keyFile = (): string => join(sshDir(), "mutagen-panel_ed25519");

const slash = (path: string): string => path.replace(/\\/g, "/");
const beginMark = (alias: string): string => `# >>> mutagen-panel:${alias} >>>`;
const endMark = (alias: string): string => `# <<< mutagen-panel:${alias} <<<`;

/** 面板写入 ~/.ssh/config 的条目;StrictHostKeyChecking accept-new 让首次连接自动记录主机指纹,又不会放过指纹变化。 */
export function renderSshBlock(server: ServerConfig, identityFile: string): string {
  return [
    beginMark(server.alias),
    `Host ${server.alias}`,
    `    HostName ${server.host}`,
    `    Port ${server.port}`,
    `    User ${server.user}`,
    `    IdentityFile "${slash(identityFile)}"`,
    "    IdentitiesOnly yes",
    "    StrictHostKeyChecking accept-new",
    endMark(server.alias),
    "",
  ].join("\n");
}

/** 去掉面板为该别名写的条目;没有则原样返回。 */
function stripBlock(content: string, alias: string): string {
  const start = content.indexOf(beginMark(alias));
  if (start < 0) return content;
  const endAt = content.indexOf(endMark(alias), start);
  if (endAt < 0) return content;
  let end = endAt + endMark(alias).length;
  if (content[end] === "\r") end += 1;
  if (content[end] === "\n") end += 1;
  return content.slice(0, start) + content.slice(end);
}

/** 用户自己写的 Host 条目里是否已有这个别名(排除面板写的条目)。 */
function hasForeignHost(content: string, alias: string): boolean {
  const wanted = alias.toLowerCase();
  return content.split(/\r?\n/).some((line) => {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    return match ? (match[1] ?? "").split(/\s+/).some((p) => p.toLowerCase() === wanted) : false;
  });
}

/** 把条目合并进 ssh 配置:已有的面板条目被替换,其余内容原样保留;与用户手写的同名 Host 冲突时抛错。block 为 null 表示删除。 */
export function mergeSshConfig(existing: string, alias: string, block: string | null): string {
  const base = stripBlock(existing, alias);
  if (block === null) return base;
  if (hasForeignHost(base, alias)) {
    throw new Error(`~/.ssh/config 里已经有手写的 Host ${alias},请换一个别名,或先手动删除那一段。`);
  }
  const separator = base === "" || base.endsWith("\n") ? "" : "\n";
  return `${base}${separator}${base === "" ? "" : "\n"}${block}`;
}

function readSshConfig(): string {
  return existsSync(sshConfigFile()) ? readFileSync(sshConfigFile(), "utf8") : "";
}

function writeSshConfig(content: string): void {
  mkdirSync(sshDir(), { recursive: true });
  writeFileSync(sshConfigFile(), content, "utf8");
}

/** 没有面板专用密钥就生成一个(无口令的 ed25519),返回公钥那一行。 */
async function ensureKey(): Promise<string> {
  if (!existsSync(keyFile())) {
    mkdirSync(sshDir(), { recursive: true });
    const result = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "mutagen-panel", "-f", keyFile()], 30_000);
    if (!result.ok) throw new Error(`生成 SSH 密钥失败(需要系统自带的 OpenSSH):${result.out}`);
  }
  const pub = readFileSync(`${keyFile()}.pub`, "utf8").trim();
  // 公钥要拼进远程命令,只接受规整的单行 ed25519 公钥
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9._-]+)?$/.test(pub)) throw new Error(`公钥文件格式异常:${keyFile()}.pub`);
  return pub;
}

function describeError(error: Error & { level?: string }): string {
  if (error.level === "client-authentication") return "用户名或密码错误,或服务器不允许密码登录。";
  if (error.level === "client-timeout") return "连接超时:请检查主机地址和端口。";
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `找不到这个主机地址,请检查有没有写错:${error.message.replace(/^getaddrinfo \w+ /, "")}`;
  if (code === "ECONNREFUSED") return "连接被拒绝:请检查端口是否正确、服务器的 SSH 服务是否在运行。";
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH") return "连不上这个地址:请检查 IP、端口和网络(防火墙、Tailscale 是否在线)。";
  return error.message;
}

/** 用密码登录并把公钥追加到 authorized_keys(已存在则不重复写)。密码只在这次连接里使用。 */
function installKey(server: ServerConfig, password: string, publicKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const command = `sh -c "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && { grep -qxF '${publicKey}' ~/.ssh/authorized_keys || echo '${publicKey}' >> ~/.ssh/authorized_keys; }"`;
    conn
      .on("ready", () => {
        conn.exec(command, (error, stream) => {
          if (error) {
            conn.end();
            reject(error);
            return;
          }
          let stderr = "";
          stream.on("close", (code: number) => {
            conn.end();
            if (code === 0) resolve();
            else reject(new Error(`写入公钥失败(退出码 ${code}):${stderr.trim()}`));
          });
          stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
          stream.resume();
        });
      })
      .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)))
      .on("error", (error: Error) => reject(new Error(describeError(error))))
      .connect({
        host: server.host,
        port: server.port,
        username: server.user,
        password,
        tryKeyboard: true,
        readyTimeout: 15_000,
      });
  });
}

/**
 * 添加或更新一台服务器:用密码把面板专用公钥装到服务器上,再把别名写进 ~/.ssh/config。
 * 密码不会保存,也不会出现在返回的文字里。
 */
export async function setupServer(server: ServerConfig, password: string): Promise<ServerResult> {
  if (password === "") return { ok: false, out: "请填写密码(只用于这一次安装密钥,不会保存)。" };
  try {
    const nextConfig = mergeSshConfig(readSshConfig(), server.alias, renderSshBlock(server, keyFile()));
    const publicKey = await ensureKey();
    await installKey(server, password, publicKey);
    writeSshConfig(nextConfig);
  } catch (error) {
    return { ok: false, out: (error as Error).message };
  }
  const check = await checkSsh(server.alias);
  return check.ok
    ? { ok: true, out: `服务器 ${server.alias} 已就绪:公钥已安装,${check.out}` }
    : { ok: false, out: `公钥已安装并写入 ~/.ssh/config,但免密登录验证没通过:\n${check.out}` };
}

/** 只测试已配置别名的免密登录,不需要密码。 */
export function testServer(alias: string): Promise<ServerResult> {
  return checkSsh(alias);
}

/** 从 ~/.ssh/config 删除面板写的条目;服务器上的 authorized_keys 不动。 */
export function removeServerEntry(alias: string): void {
  if (!existsSync(sshConfigFile())) return;
  const current = readSshConfig();
  const next = mergeSshConfig(current, alias, null);
  if (next !== current) writeSshConfig(next);
}

const endpointCache = new Map<string, { at: number; value: string }>();

/** 用 `ssh -G` 解析别名最终的 用户@主机:端口(手写在 ~/.ssh/config 里的别名也能解析);结果缓存 60 秒,解析失败返回空串。 */
export async function resolveEndpoint(alias: string): Promise<string> {
  if (alias === "" || alias.startsWith("-")) return "";
  const hit = endpointCache.get(alias);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const result = await run("ssh", ["-G", alias], 10_000);
  const value = result.ok ? parseSshG(result.stdout) : "";
  endpointCache.set(alias, { at: Date.now(), value });
  return value;
}

export function parseSshG(output: string): string {
  const pick = (key: string): string => new RegExp(`^${key} (.+)$`, "m").exec(output)?.[1]?.trim() ?? "";
  const host = pick("hostname");
  if (host === "") return "";
  const user = pick("user");
  const port = pick("port");
  return `${user ? `${user}@` : ""}${host}${port ? `:${port}` : ""}`;
}
