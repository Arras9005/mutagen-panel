import assert from "node:assert/strict";
import { parseConfig, parseWorkspace, serializeConfig, type WorkspaceConfig } from "./config.js";
import {
  fingerprintOf, linkWorkspace, listWorkspaces, mergeKnownHosts, parseCtlOutput, renderWorkspaceBlock, resolveRemoteDir, unlinkWorkspace,
  type CtlResult, type CtlRunner, type LinkDeps,
} from "./workspaces.js";
import { mergeSshConfig } from "./servers.js";

const ws: WorkspaceConfig = { alias: "vps-ws02", server: "vps", id: "ws02", user: "ws02", address: "10.200.1.2", port: 2222 };

// ---- ssh 配置条目:经服务器 ProxyJump,主机密钥钉住
const block = renderWorkspaceBlock(ws, "C:\\Users\\me\\.ssh\\mutagen-panel_ed25519", "C:\\Users\\me\\.ssh\\mutagen-panel_known_hosts");
assert.match(block, /Host vps-ws02\n/);
assert.match(block, /HostName 10\.200\.1\.2\n/);
assert.match(block, /Port 2222\n/);
assert.match(block, /User ws02\n/);
assert.match(block, /ProxyJump vps\n/);
assert.match(block, /StrictHostKeyChecking yes\n/);
assert.match(block, /HostKeyAlias vps-ws02\n/);
assert.match(block, /UserKnownHostsFile "C:\/Users\/me\/\.ssh\/mutagen-panel_known_hosts"/);
const merged = mergeSshConfig("Host other\n    HostName 9.9.9.9\n", ws.alias, block);
assert.ok(merged.includes("Host other") && merged.includes("Host vps-ws02"));
assert.equal(mergeSshConfig(merged, ws.alias, null).trim(), "Host other\n    HostName 9.9.9.9");

// ---- 已知主机:按别名替换和删除,别的行不动
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA";
assert.equal(mergeKnownHosts("", "a", key), `a ${key}\n`);
const two = mergeKnownHosts(mergeKnownHosts("", "a", key), "b", key + "B");
assert.equal(two, `a ${key}\nb ${key}B\n`);
assert.equal(mergeKnownHosts(two, "a", key + "C"), `b ${key}B\na ${key}C\n`);
assert.equal(mergeKnownHosts(two, "a", null), `b ${key}B\n`);
assert.equal(mergeKnownHosts(mergeKnownHosts("", "a", key), "a", null), "");

// ---- 目录:只能在家目录里
assert.equal(resolveRemoteDir("ws02", ""), "/home/ws02/sync");
assert.equal(resolveRemoteDir("ws02", "proj/a"), "/home/ws02/proj/a");
assert.equal(resolveRemoteDir("ws02", "/home/ws02/x/"), "/home/ws02/x");
assert.equal(resolveRemoteDir("ws02", "/home/ws02"), "/home/ws02");
for (const bad of ["../x", "a/../../b", "/etc", "/home/ws03/x", "/home/ws02x", "a\\b", "a\nb", "x".repeat(400)]) {
  assert.equal(resolveRemoteDir("ws02", bad), null, bad);
}

// ---- 指纹:和 OpenSSH 的 SHA256 写法一致
const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
assert.match(fingerprintOf(`ssh-ed25519 ${blob.toString("base64")} c`), /^SHA256:[A-Za-z0-9+/]{43}$/);

// ---- 服务器输出
assert.deepEqual(parseCtlOutput('{"ok":true,"data":{"a":1}}\n', 0, ""), { ok: true, data: { a: 1 } });
assert.match((parseCtlOutput('{"ok":false,"step":"权限检查","code":3,"message":"需要以 root 运行"}\n', 3, "") as { out: string }).out, /需要 root/);
assert.match((parseCtlOutput("", 127, "bash: workspace-ctl: command not found") as { out: string }).out, /没有 workspace-ctl/);
assert.match((parseCtlOutput("garbage", 1, "boom") as { out: string }).out, /boom/);

// ---- 配置
const base = { mutagen: "mutagen", host: "vps", servers: [{ alias: "vps", host: "1.2.3.4", port: 22, user: "root" }], sessions: [] };
const cfg = parseConfig({ ...base, workspaces: [ws] });
assert.deepEqual(cfg.workspaces, [ws]);
assert.deepEqual(parseConfig(JSON.parse(serializeConfig(cfg))).workspaces, [ws]);
assert.deepEqual(parseConfig(base).workspaces, []);
assert.throws(() => parseConfig({ ...base, workspaces: [{ ...ws, alias: "vps" }] }), /别名不能重复/);
assert.throws(() => parseConfig({ ...base, workspaces: [ws, ws] }), /别名不能重复/);
for (const bad of [{ address: "8.8.8.8" }, { address: "10.200.1.999" }, { alias: "-x" }, { port: 0 }, { id: "../x" }, { user: "a b" }, { server: "" }]) {
  assert.throws(() => parseWorkspace({ ...ws, ...bad }), /./, JSON.stringify(bad));
}

// ---- 接入流程(服务器和本机文件都用假的)
function fakeDeps(opts: { state?: string; ok?: boolean; hostKey?: boolean; fail?: string; check?: boolean } = {}) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const store = { ssh: "", known: "" };
  const ctl: CtlRunner = async (_server, args, input): Promise<CtlResult<unknown>> => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (opts.fail === args[0]) return { ok: false, out: "boom" };
    if (args[0] === "files-info") {
      return {
        ok: true,
        data: {
          id: args[1], state: opts.state ?? "running",
          files: { ok: opts.ok ?? true, address: "10.200.1.2", port: 2222, user: args[1], syncDir: "sync", keys: [], hostKey: opts.hostKey === false ? null : { type: "ssh-ed25519", key: key, fingerprint: "SHA256:x" } },
        },
      };
    }
    return { ok: true, data: {} };
  };
  const deps: LinkDeps = {
    ctl,
    publicKey: async () => `ssh-ed25519 ${blob.toString("base64")} mutagen-panel`,
    keyPath: () => "/k", knownHostsPath: () => "/kh",
    readSsh: () => store.ssh, writeSsh: (t) => { store.ssh = t; },
    readKnown: () => store.known, writeKnown: (t) => { store.known = t; },
    check: async () => ({ ok: opts.check ?? true, out: opts.check === false ? "denied" : "SSH 免密登录正常" }),
  };
  return { deps, calls, store };
}

{
  const { deps, calls, store } = fakeDeps();
  const res = await linkWorkspace(deps, "vps", "ws02", []);
  assert.ok(res.ok && res.running && res.verified);
  assert.deepEqual(calls.map((c) => c.args), [["files-info", "ws02"], ["set-sshkey", "ws02"]]);
  assert.match(calls[1]?.input ?? "", /^ssh-ed25519 \S+ mutagen-panel\n$/);
  assert.match(store.ssh, /Host vps-ws02/);
  assert.equal(store.known, `vps-ws02 ${key}\n`);
  assert.equal(res.ok && res.workspace.alias, "vps-ws02");
  // 再接一次:不重复
  const again = await linkWorkspace(deps, "vps", "ws02", res.ok ? [res.workspace] : []);
  assert.ok(again.ok);
  assert.equal(store.ssh.split("Host vps-ws02\n").length, 2);
  assert.equal(store.known.split("\n").filter(Boolean).length, 1);
}
{
  // 没运行:接入完成,不验证,不算失败
  const { deps, store } = fakeDeps({ state: "stopped", ok: false });
  const res = await linkWorkspace(deps, "vps", "ws02", []);
  assert.ok(res.ok && !res.running && !res.verified);
  assert.match(store.ssh, /Host vps-ws02/);
}
{
  // 运行中但登录验证不过:仍然接入,但说清楚
  const res = await linkWorkspace(fakeDeps({ check: false }).deps, "vps", "ws02", []);
  assert.ok(res.ok && res.running && !res.verified);
  assert.match(res.ok ? res.out : "", /登录验证没通过/);
}
{
  // 失败路径:什么都不写
  for (const fail of ["files-info", "set-sshkey"]) {
    const f = fakeDeps({ fail });
    const res = await linkWorkspace(f.deps, "vps", "ws02", []);
    assert.equal(res.ok, false, fail);
    assert.equal(f.store.ssh, "");
    assert.equal(f.store.known, "");
  }
  const noKey = fakeDeps({ hostKey: false });
  assert.equal((await linkWorkspace(noKey.deps, "vps", "ws02", [])).ok, false);
  assert.equal(noKey.store.ssh, "");
  assert.equal((await linkWorkspace(fakeDeps().deps, "vps", "../x", [])).ok, false);
  assert.equal((await linkWorkspace(fakeDeps().deps, "vps", "ws09", [])).ok, false);
}
{
  // 与手写的同名 Host 冲突:抛出,公钥已登记但本机文件不动
  const f = fakeDeps();
  f.store.ssh = "Host vps-ws02\n    HostName x\n";
  await assert.rejects(linkWorkspace(f.deps, "vps", "ws02", []), /已经有手写的 Host/);
  assert.equal(f.store.known, "");
}
{
  // 撤销:本机条目去掉,服务器上按这把公钥的指纹撤销
  const f = fakeDeps();
  const linked = await linkWorkspace(f.deps, "vps", "ws02", []);
  const out = await unlinkWorkspace(f.deps, linked.ok ? linked.workspace : ws);
  assert.match(out, /已移除/);
  assert.equal(f.store.ssh.includes("vps-ws02"), false);
  assert.equal(f.store.known, "");
  const last = f.calls[f.calls.length - 1];
  assert.deepEqual(last?.args, ["clear-sshkey", "ws02"]);
  assert.match(last?.input ?? "", /^SHA256:/);
  // 服务器连不上也不影响本机清理
  const g = fakeDeps({ fail: "clear-sshkey" });
  const lk = await linkWorkspace(g.deps, "vps", "ws02", []);
  assert.match(await unlinkWorkspace(g.deps, lk.ok ? lk.workspace : ws), /没能撤销/);
}

// ---- 列表
{
  const ctl: CtlRunner = async () => ({
    ok: true,
    data: { workspaces: [
      { id: "ws01", state: "running", user: "ws01", files: { ok: true, keys: [{}, {}] } },
      { id: "ws02", state: "stopped", user: "ws02", files: { ok: false, keys: [] } },
      { id: "evil;rm", state: "running", user: "x", files: { ok: true, keys: [] } },
    ] },
  });
  const res = await listWorkspaces(ctl, "vps", [ws]);
  assert.ok(res.ok);
  const rows = res.ok ? res.rows : [];
  assert.deepEqual(rows.map((r) => [r.id, r.channel, r.keys, r.alias]), [["ws01", true, 2, ""], ["ws02", false, 0, "vps-ws02"]]);
  assert.equal((await listWorkspaces(async () => ({ ok: true, data: {} }), "vps", [])).ok, false);
}

console.log("workspaces-test: ok");
