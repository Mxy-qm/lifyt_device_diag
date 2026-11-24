import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseConsole, evaluate } from "../core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const FIX = join(ROOT, "tests", "fixtures");
const load = (n) => readFileSync(join(FIX, n), "utf8");

const allIds = () => {
  const ids = new Set(), groups = new Set();
  for (const f of ["nb-healthy.txt", "nb-factory-default.txt", "nb-lowbattery.txt", "nb-imu-sentinel.txt", "lora-healthy.txt", "lora-locked.txt"]) {
    const v = evaluate(parseConsole(load(f)), { profile: { server: "1.1.1.1,1", apn: "x", cops: "1", nband: "8", tdc: 1, stdc: 7, ctangle: 1, ityp: "0" } });
    for (const g of v.groups) { groups.add(g.id); for (const it of g.items) ids.add(it.id); }
  }
  return { ids: [...ids], groups: [...groups] };
};

test("每个判定项在三语包里都有标签", () => {
  const { ids } = allIds();
  for (const id of ids) {
    const occurrences = (html.match(new RegExp('"' + id.replace(".", "\\.") + '":', "g")) || []).length;
    assert.ok(occurrences >= 3, 'item "' + id + '" 在三语里应各有一份，实际 ' + occurrences);
  }
});

test("每个分组在三语包里都有标签", () => {
  const { groups } = allIds();
  for (const g of groups) {
    const occurrences = (html.match(new RegExp('"?\\b' + g + '"?\\s*:', "g")) || []).length;
    assert.ok(occurrences >= 3, 'group "' + g + '" 应有三份标签，实际 ' + occurrences);
  }
});

test("脚本引用的 DOM id 都存在于页面", () => {
  const refs = new Set();
  const re = /\$\("([a-zA-Z0-9_]+)"\)/g;
  let m;
  while ((m = re.exec(html)) !== null) refs.add(m[1]);
  assert.ok(refs.size > 10, "应提取到多个 id");
  for (const id of refs) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 #" + id);
  }
});

test("页面里没有留远程脚本/外链依赖", () => {
  // 允许同源相对脚本（config.js / config.local.js），不允许任何 http(s):// 或 // 开头的脚本
  assert.ok(!/<script[^>]+src="(?:https?:)?\/\//i.test(html), "不应有远程脚本");
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/<a [^>]*>/g, "")), "不应引用外部地址");
});

test("页面不提供自由命令输入框（客户只看结果）", () => {
  assert.ok(!/id="cmd(Input|Line)?"/.test(html));
  assert.ok(!/placeholder="AT/i.test(html));
});
