import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isAllowedCommand, sanitizeScript, buildPlanScript, buildProbeScript, buildUnlockScript,
  stripLogDecorations, extractExchanges,
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
  // NB 固件取值为 AT+X=?，并带裸写备选
  assert.ok(nb.some((s) => s.line === "AT+DEVID=?"));
  // 裸写 = "Run"，有副作用（v1.3 实测会 AT_ERROR 甚至重启），剧本里不应再有备选
  assert.ok(nb.every((s) => !s.alt), "NB 剧本不应再带裸写备选");
  assert.ok(!lora.some((s) => s.line === "AT+DEVID=?"));
  assert.ok(lora.some((s) => s.line === "AT+CFG"));
  assert.ok(nb.every((s) => s.kind !== "send" || s.raw || isAllowedCommand(s.line)));
  assert.ok(nb.every((s) => !s.alt || isAllowedCommand(s.alt)));
});

test("探测剧本会重启拿启动块，重启后有再解锁", () => {
  const probe = buildProbeScript({ password: "123456" });
  assert.ok(probe.some((s) => s.line === "ATZ"), "探测要发 ATZ");
  assert.ok(probe.some((s) => s.raw && s.line === "123456"), "探测要带密码");
  const unlock = buildUnlockScript("123456");
  assert.equal(unlock.length, 1);
  assert.equal(unlock[0].raw, true);
  assert.deepEqual(buildUnlockScript(""), []);
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
  // 两段是同一时刻的同一块日志（粘贴的报告里会出现这种情况），按 RTC 去重后只算一次启动
  assert.equal(r.banners, 1);
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

test("没解锁时不把「没读到」当成异常", () => {
  const lockedText = [
    "DRAGINO TSE NB Device",
    "Image Version: TSE NB v1.4 260826",
    "Time: 26/11/20 09:12:44",
    "Angle",
    "Roll=-90.35 Pitch=107.50",
    "Internal Comparison Angle",
    "Roll:-90.12 Pitch:107.33",
    "Device ID= 869930000000117",
    "Product ID= 1106",
    "AuthInfo= LFTAN000117HWsy",
    "APN= cmhk",
    "COPS= 45412",
    "Server IP & PORT= 183.0.0.0,5683",
    "Correct Password".replace("Correct ", "")
  ].join("\n");
  const r = parseConsole(lockedText);
  assert.equal(r.flags.passwordAccepted, false);
  const v = evaluate(r, { locked: true });
  const L = levels(v);
  assert.equal(v.locked, true);
  assert.equal(L.get("pwr.battery"), "skip", "没拿到电池电压应标未检查，而不是提示");
  assert.equal(L.get("cfg.intervals"), "skip");
  assert.equal(L.get("cfg.ctangle"), "skip");
  assert.equal(v.verdict, "pass", "解锁缺失本身不该把结论压成 warn/fail");
  const v2 = evaluate(parseConsole(load("nb-lowbattery.txt")));
  assert.equal(v2.locked, false);
});

test("界面日志前缀不会污染解析", () => {
  const withArrows = "← DRAGINO TSE NB Device\n← APN= JWE\n← COPS= 45412\n← Server IP & PORT= 47.1.2.3,6002\n← Time: 26/11/20 09:12:44\n[skip] 剧本里出现非查询命令：\n→ AT+VER\n";
  const r = parseConsole(withArrows);
  assert.equal(r.config.apn, "JWE");
  assert.equal(r.config.cops, "45412");
  assert.equal(r.config.server, "47.1.2.3,6002");
  assert.ok(r.rtc && r.rtc.y4 === 2026);
  assert.equal(stripLogDecorations("← APN= JWE").trim(), "APN= JWE");
});

test("没抓到的项标未读，不当成异常", () => {
  const noBattery = [
    "DRAGINO TSE NB Device",
    "Image Version: TSE NB v1.4 260623",
    "Time: 21/1/29 02:51:59",
    "Angle", "Roll=-92.99 Pitch=165.48",
    "Internal Comparison Angle", "Roll:-84.77 Pitch:7.98",
    "Device ID= 161628395", "Product ID= 16000695", "AuthInfo= LFTAN00605az6FG",
    "APN= JWE", "COPS= 45412", "Server IP & PORT= 47.91.203.178,6002",
    "Correct Password"
  ].join("\n");
  const r = parseConsole(noBattery);
  const v = evaluate(r, { locked: false });
  const L = levels(v);
  assert.equal(L.get("pwr.battery"), "skip", "没回 AT+BAT 时应标未读，不该说电压低");
  assert.equal(v.groups.find((g) => g.id === "power").items[0].reason, "unread");
  assert.equal(L.get("cfg.apn"), "pass", "APN 有值就是通过");
  assert.equal(L.get("cfg.cops"), "pass");
  assert.equal(L.get("time.rtc"), "warn", "RTC 2021 应提示");
});

test("有配置但没网：CSQ/注册/SIM 都要指出，配置本身仍判通过", () => {
  const r = parseConsole(load("nb-no-network.txt"));
  const v = evaluate(r, { locked: false });
  const L = levels(v);
  assert.equal(L.get("cfg.apn"), "pass");
  assert.equal(L.get("cfg.server"), "pass");
  assert.equal(L.get("net.csq"), "warn");
  assert.equal(L.get("net.reg"), "warn");
  assert.equal(L.get("net.sim"), "warn", "CIMI 报错应指向 SIM 未就绪");
  assert.equal(L.get("pwr.battery"), "skip");
  assert.equal(v.verdict, "warn");
});

test("裸值响应按 TX 配对归位", () => {
  const log = [
    "TX> AT+VER=?", "TSE NB v1.4 260623", " ", "OK",
    "TX> AT+TDC=?", "10800000", "OK",
    "TX> AT+STDC=?", "3600000", "OK",
    "TX> AT+BAT=?", "BAT voltage=3683mV", "OK",
    "TX> AT+DATE=?", "21/1/30 02:25:54", "OK",
    "TX> AT+CGSN", "+CSQ:99,99 Query whether the network is activated? 3", "+NBAND:8", "OK"
  ].join("\n");
  const r = parseConsole(log);
  assert.equal(r.firmware, "TSE NB v1.4 260623");
  assert.equal(r.config.tdc, 10800000);
  assert.equal(r.config.stdc, 3600000);
  assert.equal(r.batteryMv, 3683);
  assert.equal(r.rtc.y4, 2021);
  assert.equal(r.network.imei, null, "异步噪音不能当成 IMEI");
  const ex = extractExchanges(log);
  assert.equal(ex.length, 6);
});

test("异步状态行不会被当成参数值", () => {
  const log = [
    "TX> AT+ITYP=?", "AT_ERROR",
    "TX> AT+ITYP", "Attached",
    "TX> AT+CTANGLE=?", "10", "OK",
    "TX> AT+TDC=?", "10800000", "OK"
  ].join("\n");
  const r = parseConsole(log);
  assert.equal(r.config.ityp, null, "Attached 不是安装方式");
  assert.equal(r.config.ctangle, 10);
  assert.equal(r.config.tdc, 10800000);
});

test("诊断中途重启会被点出来", () => {
  const boot = (t) => ["DRAGINO TSE NB Device", "Image Version: TSE NB v1.3 231218", "Time: " + t, "Angle", "Roll=-90.67 Pitch=131.38", "Internal Comparison Angle", "Roll:15.97 Pitch:8.13", "Device ID= 161275545", "Product ID= 16000695", "AuthInfo= LFT0153afs", "Server IP & PORT= 47.91.203.178,6002", "REBOOT_CAUSE_APPLICATION_AT"].join("\n");
  const r = parseConsole(boot("26/11/25 16:50:21") + "\n" + boot("26/11/25 16:51:03"));
  assert.equal(r.banners, 2);
  const v = evaluate(r, { locked: false });
  const L = levels(v);
  assert.equal(L.get("log.reboots"), "warn");
});

test("掩码只留尾号", () => {
  assert.equal(maskValue("869930000000117"), "…117");
  assert.equal(maskValue(null), "—");
  assert.equal(maskValue("ab"), "ab");
});
