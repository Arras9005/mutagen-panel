#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Panel, type ActionRequest } from "./actions.js";
import { ensureConfig, loadConfig, resolveConfigFile, type PanelConfig } from "./config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(name);
const optionValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function exitWith(message: string): never {
  console.error(`\n[错误] ${message}\n`);
  process.exit(1);
}

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "";

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`mutagen-panel ${version}\n本机运行的 Mutagen 网页管理面板。\n
用法: mutagen-panel [选项]

  --config <文件>   配置文件路径(也可用环境变量 PANEL_CONFIG)
  --port <端口>     本次运行使用的端口(覆盖配置里的 port,不写回配置)
  --no-open         启动时不自动打开浏览器
  -v, --version     显示版本
  -h, --help        显示帮助

默认配置文件:从 npm 安装时是 ~/.mutagen-panel/config.json,从源码运行时是目录下的 config.json;
不存在会自动创建。`);
  process.exit(0);
}
if (hasFlag("--version") || hasFlag("-v")) {
  console.log(version);
  process.exit(0);
}

const configFile = resolveConfigFile(root, optionValue("--config"));
try {
  if (ensureConfig(configFile)) console.log(`[配置] 首次运行,已创建配置文件:${configFile}`);
} catch (error) {
  exitWith(`无法创建配置文件 ${configFile}:${(error as Error).message}`);
}

function loadOrExit(): PanelConfig {
  try {
    return loadConfig(configFile);
  } catch (error) {
    return exitWith((error as Error).message);
  }
}

const config = loadOrExit();
const portArg = optionValue("--port");
const listenPort = portArg === undefined ? config.port : Number(portArg);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) exitWith("--port 必须是 1-65535 的整数");
const shouldOpenBrowser = config.openBrowser && !hasFlag("--no-open");
const panel = new Panel(config, configFile);
const token = config.token ?? randomBytes(16).toString("hex");
const allowedHosts = [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`];

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    // 页面是自包含的(内联脚本/样式,只请求同源接口):不允许被嵌入别的页面,也不加载任何外部资源
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > 65_536) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}

function tokenMatches(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers["x-token"] ?? ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = createServer(async (req, res) => {
  try {
    // 只接受访问本机地址的请求,防止 DNS 重绑定
    if (!allowedHosts.includes(String(req.headers.host))) {
      send(res, 403, { error: "forbidden host" });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && pathname === "/") {
      send(res, 200, readFileSync(join(root, "web", "index.html"), "utf8"), "text/html; charset=utf-8");
      return;
    }
    if (pathname.startsWith("/api/")) {
      if (!tokenMatches(req)) {
        send(res, 401, { error: "invalid token" });
        return;
      }
      if (req.method === "GET" && pathname === "/api/state") {
        send(res, 200, await panel.getState());
        return;
      }
      if (req.method === "GET" && pathname === "/api/config") {
        send(res, 200, panel.getEditableConfig());
        return;
      }
      if (req.method === "POST" && pathname === "/api/config") {
        const body = JSON.parse((await readBody(req)) || "{}") as { host?: unknown; groups?: unknown; sessions?: unknown };
        send(res, 200, panel.saveEditedConfig(body));
        return;
      }
      if (req.method === "GET" && pathname === "/api/servers") {
        send(res, 200, panel.getServers());
        return;
      }
      if (req.method === "GET" && pathname === "/api/files") {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        send(res, 200, await panel.compareSessionFiles(query.get("id") ?? ""));
        return;
      }
      if (req.method === "GET" && pathname === "/api/file-diff") {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const side = query.get("side");
        send(res, 200, await panel.diffSessionFile(query.get("id") ?? "", query.get("path") ?? "", side === "local" || side === "server" ? side : "both"));
        return;
      }
      if (req.method === "GET" && pathname === "/api/remote-ls") {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        send(res, 200, await panel.browseRemote(query.get("host") ?? "", query.get("path") ?? "~"));
        return;
      }
      if (req.method === "POST" && pathname === "/api/servers") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        send(res, 200, await panel.saveServer(body));
        return;
      }
      if (req.method === "POST" && pathname === "/api/servers/delete") {
        const body = JSON.parse((await readBody(req)) || "{}") as { alias?: unknown };
        send(res, 200, await panel.deleteServer(String(body.alias ?? "")));
        return;
      }
      if (req.method === "POST" && pathname === "/api/servers/test") {
        const body = JSON.parse((await readBody(req)) || "{}") as { alias?: unknown };
        send(res, 200, await panel.testServer(String(body.alias ?? "")));
        return;
      }
      if (req.method === "POST" && pathname === "/api/action") {
        const request = JSON.parse((await readBody(req)) || "{}") as ActionRequest;
        send(res, 200, await panel.perform(request));
        return;
      }
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    send(res, 500, { ok: false, out: (error as Error).message });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  exitWith(error.code === "EADDRINUSE" ? `端口 ${listenPort} 已被占用,请在配置里改 port,或用 --port 指定别的端口。` : error.message);
});

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
  } catch {
    // 打不开浏览器时,用户可手动复制控制台里的链接
  }
}

server.listen(listenPort, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${listenPort}/?token=${token}`;
  console.log(`Mutagen 面板已启动(仅本机可访问):\n  ${url}\n关闭此窗口即停止面板,不影响已创建的同步会话。`);
  console.log(`配置文件:${configFile}`);
  if (shouldOpenBrowser) openBrowser(url);
});
