import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isAllowedCommand, sanitizeScript, buildPlanScript, buildProbeScript,
  detectVariant, parseConsole, parseRtc, evaluate, maskValue
} from "../core.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => readFileSync(join(FIX, name), "utf8");
const levels = (v) => {
  const map = new Map();
  for (const g of v.groups) for (const it of g.items) map.set(it.id, it.level);
  return map;
};

/* ---------- 命令白名单 ---------- */
test("白名单只放查询命令，写入一律拒绝", () => {
  for (const ok of ["AT", "AT+VER", "AT+CFG", "AT+BAT", "AT+NBAND?", "AT+SERIP", "ATZ"]) {
    assert.equal(isAllowedCommand(ok), true, ok + " 应允许");
  }
  for (const bad of ["AT+SERIP=1.2.3.4,5683", "AT+CTANGLE=10", "AT+DEVID=123", "AT+CICANGLE", "AT+FDR", "AT+DISAT", "AT+PWORD=123456", "AT+SLEEP", "AT+SIMLOCK=1"]) {
    assert.equal(isAllowedCommand(bad), false, bad + " 应拒绝");
  }
});

test("剧本里被篡改的写命令会被剔除", () => {
  const steps = sanitizeScript([
    { kind: "send", line: "AT+VER" },
    { kind: "send", line: "AT+SERIP=9.9.9.9,1" },
    { kind: "listen", ms: 10 },
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].line, "AT+VER");
});

test("主剧本随变体变化，且都可审计", () => {
  const nb = buildPlanScript("nb", { password: "123456", reboot: true });
  const lora = buildPlanScript("lora", { password: "", reboot: false });
  assert.ok(nb.some((s) => s.line === "AT+DEVID"));
  assert.ok(!lora.some((s) => s.line === "AT+DEVID"));
  assert.ok(lora.some((s) => s.line === "AT+CFG"));
  assert.ok(nb.every((s) => s.kind !== "send" || s.raw || isAllowedCommand(s.line)));
  assert.ok(buildProbeScript({ password: "x" }).some((s) => s.line === "AT+VER"));
});

/* ---------- 解析 ---------- */
test("变体识别", () => {
  assert.equal(detectVariant(load("nb-healthy.txt")), "nb");
  assert.equal(detectVariant(load("lora-healthy.txt")), "lora");
  assert.equal(detectVariant("random text"), "unknown");
});

test("RTC 双形态解析", () => {
  assert.equal(parseRtc("26/11/20 09:12:44").y4, 2026);
  assert.equal(parseRtc("2026-11-20 09:12:44").y4, 2026);
  assert.equal(parseRtc("0/1/1 00:00:11").synced, false);
});

test("NB 健康日志字段全解析", () => {
  const r = parseConsole(load("nb-healthy.txt"));
  assert.equal(r.variant, "nb");
  assert.equal(r.firmware, "TSE NB v1.4 260826");
  assert.deepEqual(r.angle, { roll: -90.35, pitch: 107.5 });
  assert.deepEqual(r.icangle, { roll: -90.12, pitch: 107.33 });
  assert.equal(r.batteryMv, 3691);
  assert.equal(r.rebootCause, "APPLICATION_AT");
  assert.equal(r.identity.deviceId, "869930000000117");
  assert.equal(r.identity.authInfo, "LFTAN000117HWsy");
  assert.equal(r.config.server, "183.0.0.0,5683");
  assert.equal(r.config.apn, "cmhk");
  assert.equal(r.config.cops, "45412");
  assert.equal(r.config.nband, "8");
  assert.equal(r.config.tdc, 1800000);
  assert.equal(r.config.stdc, 1800000);
  assert.equal(r.config.ctangle, 10);
  assert.equal(r.config.ityp, "1");
  assert.deepEqual(r.network.csq, { rssi: 13, ber: 99 });
  assert.equal(r.network.imei, "868723010000117");
  assert.equal(r.flags.passwordAccepted, true);
  assert.equal(r.flags.error, false);
});

test("同一日志重复启动块只认最后一个", () => {
  const one = load("nb-factory-default.txt");
  const two = one.replace("Device ID= 1234567890", "Device ID= 869930000000400").replace("Server IP & PORT= 0.0.0.0,0", "Server IP & PORT= 183.0.0.0,5683");
  const r = parseConsole(one + "\n" + two);
  assert.equal(r.identity.deviceId, "869930000000400");
  assert.equal(r.config.server, "183.0.0.0,5683");
  assert.equal(r.banners, 2);
});

/* ---------- 判定 ---------- */
test("健康设备判 PASS", () => {
  const v = evaluate(parseConsole(load("nb-healthy.txt")));
  assert.equal(v.verdict, "pass", JSON.stringify(v.counts));
  assert.equal(levels(v).get("pwr.battery"), "pass");
  assert.equal(levels(v).get("sen.alarmDiff"), "pass");
});

test("出厂默认配置判 FAIL，且指明关键项", () => {
  const v = evaluate(parseConsole(load("nb-factory-default.txt")));
  const L = levels(v);
  assert.equal(v.verdict, "fail");
  assert.equal(L.get("id.deviceId"), "fail");
  assert.equal(L.get("id.authInfo"), "fail");
  assert.equal(L.get("cfg.server"), "fail");
  assert.equal(L.get("cfg.apn"), "fail");
  assert.equal(L.get("time.rtc"), "warn");
});

test("低电量判 FAIL，对比角差距判 WARN", () => {
  const v = evaluate(parseConsole(load("nb-lowbattery.txt")));
  const L = levels(v);
  assert.equal(v.verdict, "fail");
  assert.equal(L.get("pwr.battery"), "fail");
  assert.equal(L.get("sen.alarmDiff"), "warn");
});

test("IMU 无效值判 FAIL", () => {
  const v = evaluate(parseConsole(load("nb-imu-sentinel.txt")));
  assert.equal(levels(v).get("sen.angle"), "fail");
  assert.equal(v.verdict, "fail");
});

test("LoRa 变体健康日志判 PASS", () => {
  const r = parseConsole(load("lora-healthy.txt"));
  assert.equal(r.variant, "lora");
  assert.equal(r.firmware, "TSE v2.5 260826");
  assert.equal(r.band, "EU868");
  assert.equal(r.batteryMv, 3691);
  const v = evaluate(r);
  const L = levels(v);
  assert.equal(L.get("net.join"), "pass");
  assert.equal(L.get("net.rssi"), "pass");
  assert.equal(v.verdict, "pass", JSON.stringify(v.counts));
});

test("LoRa 全零 DevEUI + 密码错误 + 默认 RTC", () => {
  const v = evaluate(parseConsole(load("lora-locked.txt")));
  const L = levels(v);
  assert.equal(L.get("id.devEui"), "fail");
  assert.equal(L.get("time.rtc"), "warn");
  assert.equal(L.get("log.password"), "warn");
  assert.equal(v.verdict, "fail");
});

test("给了批次期望值后按期望值判", () => {
  const r = parseConsole(load("nb-healthy.txt"));
  const ok = evaluate(r, { profile: { server: "183.0.0.0,5683", apn: "cmhk", cops: "45412", nband: "8", tdc: 1800000, stdc: 1800000, ctangle: 10, ityp: "1", productId: "1106" } });
  assert.equal(ok.verdict, "pass", JSON.stringify(ok.counts));
  const bad = evaluate(r, { profile: { server: "1.1.1.1,5683", apn: "cmnbiot" } });
  const L = levels(bad);
  assert.equal(L.get("cfg.server"), "fail");
  assert.equal(L.get("cfg.apn"), "fail");
  assert.equal(bad.verdict, "fail");
  assert.deepEqual(bad.groups.find((g) => g.id === "config").items.find((i) => i.id === "cfg.server").expected, "1.1.1.1,5683");
});

test("掩码只留尾号", () => {
  assert.equal(maskValue("869930000000117"), "…117");
  assert.equal(maskValue(null), "—");
  assert.equal(maskValue("ab"), "ab");
});
