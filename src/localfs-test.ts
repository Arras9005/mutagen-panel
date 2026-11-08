import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listLocal, listRoots, makeLocalFolder, parentOf, removeLocalFolder, validFolderName } from "./localfs.js";

const base = mkdtempSync(join(tmpdir(), "localfs-"));
try {
  mkdirSync(join(base, "b-dir"));
  mkdirSync(join(base, "a-dir"));
  mkdirSync(join(base, "10-dir"));
  mkdirSync(join(base, "2-dir"));
  mkdirSync(join(base, ".hidden"));
  writeFileSync(join(base, "file.txt"), "x");

  // 列表:只有文件夹、不含隐藏的、自然排序
  const list = listLocal(base);
  assert.equal(list.ok, true);
  assert.deepEqual(list.entries.map((e) => e.name), ["2-dir", "10-dir", "a-dir", "b-dir"]);
  assert.equal(list.parent, join(base, ".."));
  assert.ok(list.roots.length >= 2);
  assert.equal(listLocal("").path, homedir());

  // 不存在、不是绝对路径、是文件
  assert.equal(listLocal(join(base, "nope")).ok, false);
  assert.match(listLocal("relative/dir").out, /完整路径/);
  assert.equal(listLocal(join(base, "file.txt")).ok, false);

  // 上一级
  assert.equal(parentOf("/"), null);
  assert.equal(parentOf("/a/b"), "/a");
  assert.equal(parentOf(""), null);

  // 快捷入口
  const roots = listRoots("linux", () => false, "/home/u");
  assert.deepEqual(roots.map((r) => r.path), ["/home/u", "/"]);
  const winRoots = listRoots("win32", (p) => p === "C:\\" || p === "E:\\" || p === "C:\\Users\\me\\Desktop", "C:\\Users\\me");
  assert.deepEqual(winRoots.map((r) => r.path), ["C:\\Users\\me", "C:\\Users\\me\\Desktop", "C:\\", "E:\\"].map((p) => p));

  // 名字规则
  for (const bad of ["", " ", ".", "..", "a/b", "a\\b", "a:b", "a*", "x?", "a|b", "con", "NUL.txt", "end.", "end ", " lead", "x".repeat(101), "a\nb"]) {
    assert.notEqual(validFolderName(bad), null, JSON.stringify(bad));
  }
  for (const good of ["项目", "my-app", "a b", "v1.2", "中文 文件夹"]) assert.equal(validFolderName(good), null, good);

  // 新建
  const made = makeLocalFolder(base, "新项目");
  assert.deepEqual(made, { ok: true, out: "", path: join(base, "新项目") });
  assert.ok(existsSync(join(base, "新项目")));
  assert.match(makeLocalFolder(base, "新项目").out, /同名/);
  assert.match(makeLocalFolder(base, "../x").out, /不能有/);
  assert.equal(makeLocalFolder(join(base, "nope"), "x").ok, false);
  assert.match(makeLocalFolder("rel", "x").out, /先进入/);
  assert.equal(existsSync(join(base, "..", "x")), false);

  // 删除:空的才删;非空拒绝;不存在、文件、根目录、主目录拒绝
  assert.equal(removeLocalFolder(join(base, "新项目")).ok, true);
  assert.equal(existsSync(join(base, "新项目")), false);
  mkdirSync(join(base, "full"));
  writeFileSync(join(base, "full", "x"), "1");
  const refused = removeLocalFolder(join(base, "full"));
  assert.equal(refused.ok, false);
  assert.match(refused.out, /不是空的/);
  assert.ok(existsSync(join(base, "full", "x")));
  assert.equal(removeLocalFolder(join(base, "nope")).ok, false);
  assert.equal(removeLocalFolder(join(base, "file.txt")).ok, false);
  assert.match(removeLocalFolder("/").out, /不能删除/);
  assert.match(removeLocalFolder(homedir()).out, /不能删除/);
  assert.match(removeLocalFolder("rel").out, /不合法/);
  mkdirSync(join(base, "fake-home"));
  assert.match(removeLocalFolder(join(base, "fake-home"), join(base, "fake-home")).out, /不能删除/);
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log("localfs-test: ok");
