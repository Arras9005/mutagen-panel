import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Panel } from "./actions.js";
import { parseConfig, type WorkspaceConfig } from "./config.js";
import type { CtlResult, CtlRunner, LinkDeps } from "./workspaces.js";

// 「按配置重建」隔离区的会话:先重新接入(服务器升级后登录用户和主机公钥都会变),目录不在新的同步范围里就停下。
// Mutagen 指向一个不存在的路径:重新接入之后的步骤在这里不测(各系统上都没有真的 Mutagen)。

const dir = mkdtempSync(join(tmpdir(), "mp-actions-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const ws: WorkspaceConfig = { alias: "vps-ws02", server: "vps", id: "ws02", user: "ws02", address: "10.200.1.2", port: 2222 };
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA";

function panel(remotePath: string, opts: { fail?: boolean } = {}) {
  const config = parseConfig({
    mutagen: join(dir, "no-such-mutagen"), host: "vps",
    servers: [{ alias: "vps", host: "1.2.3.4", port: 22, user: "root" }],
    workspaces: [ws],
    sessions: [{ id: "s1", name: "ws02-data", label: "ws02 · data", host: "vps-ws02", remotePath, local: join(dir, "local"), mode: "two-way-safe", ignoreVcs: false, ignore: [] }],
  });
  const calls: string[][] = [];
  const store = { ssh: "", known: `vps-ws02 ssh-ed25519 OLDKEY\n` };
  const ctl: CtlRunner = async (_server, args): Promise<CtlResult<unknown>> => {
    calls.push(args);
    if (opts.fail) return { ok: false, out: "连不上服务器" };
    if (args[0] === "files-info") {
      return { ok: true, data: { id: "ws02", state: "stopped", files: {
        ok: false, address: "10.200.1.2", port: 2222, user: "ws02f", workspaceUser: "ws02", syncDir: "data", keys: [],
        hostKey: { type: "ssh-ed25519", key, fingerprint: "SHA256:x" },
      } } };
    }
    return { ok: true, data: {} };
  };
  const link: LinkDeps = {
    ctl, publicKey: async () => "ssh-ed25519 AAAA mutagen-panel", keyPath: () => "/k", knownHostsPath: () => "/kh",
    readSsh: () => store.ssh, writeSsh: (t) => { store.ssh = t; },
    readKnown: () => store.known, writeKnown: (t) => { store.known = t; },
    check: async () => ({ ok: true, out: "ok" }),
  };
  const p = new Panel(config, join(dir, `config-${Math.random().toString(36).slice(2)}.json`));
  p.constructorDeps = { ctl, link };
  return { p, calls, store };
}

{
  // 升级后的服务器:重新接入,登录用户换成 ws02f,主机公钥换成新的,再往下重建
  const { p, calls, store } = panel("/home/ws02/data");
  const res = await p.perform({ action: "rebuild", id: "s1", confirm: true });
  assert.match(res.out, /已重新接入隔离区 vps-ws02\(登录用户 ws02f/);
  assert.deepEqual(calls.map((c) => c[0]), ["files-info", "set-sshkey"]);
  assert.match(store.ssh, /User ws02f\n/);
  assert.equal(store.known, `vps-ws02 ${key}\n`);
  assert.equal(p.getWorkspaces().find((w) => w.alias === "vps-ws02")?.user, "ws02f");
}
{
  // 会话同步的是整个家目录(老服务器上可以):新服务器上看不到,停下,旧会话和配置都不动
  const { p } = panel("/home/ws02");
  const res = await p.perform({ action: "rebuild", id: "s1", confirm: true });
  assert.equal(res.ok, false);
  assert.match(res.out, /只能同步 \/home\/ws02\/data 里面的文件夹/);
  assert.equal(p.getWorkspaces()[0]?.user, "ws02");
}
{
  // 连不上服务器:不重建,旧会话不动
  const { p } = panel("/home/ws02/data", { fail: true });
  const res = await p.perform({ action: "rebuild", id: "s1", confirm: true });
  assert.equal(res.ok, false);
  assert.match(res.out, /重新接入隔离区 vps-ws02 失败,旧会话没有动/);
}

console.log("actions-test: ok");
