import assert from "node:assert/strict";
import { agentsBundle, candidateDirs, diagnose, findMutagen, installCommands, pathDirs, type EnvDeps } from "./env.js";
import type { RunResult } from "./mutagen.js";

const ok = (out: string): RunResult => ({ ok: true, code: 0, stdout: out, out });
const missing: RunResult = { ok: false, code: -1, stdout: "", out: "找不到可执行文件" };

function deps(over: Partial<EnvDeps> & { files?: string[]; runs?: Record<string, RunResult> } = {}): EnvDeps {
  const files = new Set(over.files ?? []);
  const runs = over.runs ?? {};
  return {
    platform: "win32", arch: "x64", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\a;C:\\b" }, home: "C:\\Users\\me",
    exists: (p) => files.has(p), realpath: (p) => p,
    run: async (cmd, args) => runs[`${cmd} ${args.join(" ")}`] ?? (cmd.endsWith("ssh") ? ok("OpenSSH_9") : missing),
    ...over,
  };
}

// 目录
assert.deepEqual(pathDirs({ platform: "win32", env: { Path: '"C:\\a"; C:\\b ;' } }), ["C:\\a", "C:\\b"]);
assert.deepEqual(pathDirs({ platform: "linux", env: { PATH: "/a:/b::" } }), ["/a", "/b"]);
assert.ok(candidateDirs({ platform: "darwin", env: {}, home: "/Users/m" }).includes("/opt/homebrew/bin"));
assert.ok(candidateDirs({ platform: "win32", env: { LOCALAPPDATA: "L" }, home: "H" }).some((d) => d.endsWith("mutagen")));
assert.ok(candidateDirs({ platform: "linux", env: {}, home: "/h" }).includes("/h/.local/bin"));

// 找 mutagen:PATH 优先,然后常见位置;能运行才算
{
  const path = "C:\\b\\mutagen.exe";
  const d = deps({ files: [path], runs: { [`${path} version`]: ok("0.18.1") } });
  assert.deepEqual(await findMutagen(d, "mutagen"), { path, how: "PATH" });
}
{
  const path = "C:\\Users\\me\\mutagen\\mutagen.exe";
  const d = deps({ files: [path], runs: { [`${path} version`]: ok("0.18.1") } });
  assert.deepEqual(await findMutagen(d, "mutagen"), { path, how: "常见安装位置" });
}
{
  const path = "C:\\b\\mutagen.exe";   // 存在但运行不了(损坏)
  assert.equal(await findMutagen(deps({ files: [path] }), "mutagen"), null);
  assert.equal(await findMutagen(deps(), "mutagen"), null);
}

// 代理程序包:同目录,或符号链接的真实位置,或 ../libexec
{
  const d = (files: string[], real?: string) => ({ platform: "linux" as const, exists: (p: string) => files.includes(p), realpath: () => real ?? "" });
  assert.equal(agentsBundle({ ...d(["/m/mutagen-agents.tar.gz"], "/m/mutagen") }, "/m/mutagen"), "/m/mutagen-agents.tar.gz");
  assert.ok(agentsBundle(d(["/cellar/bin/mutagen-agents.tar.gz"], "/cellar/bin/mutagen"), "/usr/local/bin/mutagen"));
  assert.ok(agentsBundle(d(["/cellar/libexec/mutagen-agents.tar.gz"], "/cellar/bin/mutagen"), "/usr/local/bin/mutagen"));
  assert.equal(agentsBundle(d([], "/m/mutagen"), "/m/mutagen"), null);
}

// 命令:每个平台都有、不含奇怪的东西
for (const [platform, arch, needle] of [["win32", "x64", /mutagen_windows_amd64_v\$v\.zip/], ["darwin", "arm64", /brew install mutagen-io\/mutagen\/mutagen/], ["linux", "x64", /mutagen_linux_amd64_v\$v\.tar\.gz/]] as const) {
  const text = installCommands(platform, arch);
  assert.match(text, needle);
  assert.match(text, /0\.18\.1/);
}
assert.match(installCommands("darwin", "arm64"), /mutagen_darwin_arm64/);

// 体检:全好
{
  const path = "C:\\m\\mutagen.exe";
  const d = deps({ files: ["C:\\m\\mutagen-agents.tar.gz"], runs: { [`${path} version`]: ok("0.18.1"), [`${path} daemon start`]: ok(""), "ssh -V": ok("OpenSSH_9") } });
  const r = await diagnose(d, path);
  assert.equal(r.ok, true);
  assert.equal(r.fixedPath, null);
  assert.equal(r.items.length, 4);
}
// 体检:路径不对但能找到 → 给出修正路径
{
  const found = "C:\\b\\mutagen.exe";
  const d = deps({ files: [found, "C:\\b\\mutagen-agents.tar.gz"], runs: { [`${found} version`]: ok("0.18.1"), [`${found} daemon start`]: ok("") } });
  const r = await diagnose(d, "mutagen");
  assert.equal(r.fixedPath, found);
  assert.equal(r.ok, true);
  assert.match(r.text, /已在PATH找到并改用/);
}
// 体检:缺代理程序包
{
  const path = "C:\\m\\mutagen.exe";
  const r = await diagnose(deps({ runs: { [`${path} version`]: ok("0.18.1"), [`${path} daemon start`]: ok("") } }), path);
  assert.equal(r.ok, false);
  assert.match(r.text, /mutagen-agents\.tar\.gz/);
}
// 体检:完全没有 → 把安装命令写出来
{
  const r = await diagnose(deps(), "mutagen");
  assert.equal(r.ok, false);
  assert.equal(r.fixedPath, null);
  assert.match(r.text, /Invoke-WebRequest/);
  assert.match(r.text, /Expand-Archive/);
}
// 体检:没有 ssh → 说明怎么装
{
  const path = "C:\\m\\mutagen.exe";
  const r = await diagnose(deps({ files: ["C:\\m\\mutagen-agents.tar.gz"], runs: { [`${path} version`]: ok("0.18.1"), [`${path} daemon start`]: ok(""), "ssh -V": missing } }), path);
  assert.equal(r.ok, false);
  assert.match(r.text, /OpenSSH 客户端/);
}

console.log("env-test: ok");
