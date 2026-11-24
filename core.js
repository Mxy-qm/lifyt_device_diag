/**
 * core.js — 设备诊断内核：协议事实、固定剧本、日志解析、判定规则。
 *
 * 设计约束（alpha）：
 *  1. 剧本只允许查询类命令：任何带 "=<值>" 的写入命令在 isAllowedCommand() 处直接被拒。
 *  2. 解析器不猜：字段全部来自设备控制台真实输出（来源见 docs/protocol-notes.md）。
 *  3. 本文件不碰 DOM，浏览器与 node 测试共用。
 */

export const APP_VERSION = "0.1.4-alpha";

/** 设备控制台协议事实 */
export const PROTOCOL = {
  baudRate: 9600,
  lineEnding: "\r\n",
  unlockHint: "Enter Password to Active AT Commands",
};

/* ------------------------------------------------------------------ *
 * 1. 命令白名单
 * ------------------------------------------------------------------ */

const SAFE_EXACT = new Set([
  "AT", "ATI", "ATZ",
  "AT+CFG", "AT+VER", "AT+BAT", "AT+DATE", "AT+ICANGLE", "AT+CTANGLE",
  "AT+STDC", "AT+TDC", "AT+DEVID", "AT+PROID", "AT+SERIP", "AT+AUTHINFO",
  "AT+ITYP", "AT+EXTI", "AT+NJS", "AT+RSSI", "AT+SNR", "AT+CSQ",
  "AT+NUESTATS", "AT+CGSN", "AT+CIMI", "AT+CGMM", "AT+CGMR", "AT+ICCID", "AT+NCCID"
]);

/** 任何情况下都不发的命令（恢复出厂、关 AT、SIM 锁、清对比角、休眠） */
const DENY_PREFIX = ["AT+FDR", "AT+DISAT", "AT+SIMLOCK", "AT+CICANGLE", "AT+SLEEP", "AT+WTRT", "AT+PWORD"];

/**
 * 判断一条命令是否允许由本工具发送。
 * 规则：AT 开头；不在禁用前缀；除 ATZ 外不允许出现 "=<值>"（即禁止写配置）；
 *      仅允许 SAFE_EXACT 与形如 AT+XXX? 的查询。
 */
export function isAllowedCommand(line) {
  if (typeof line !== "string") return false;
  const raw = line.trim();
  if (!raw) return false;
  const L = raw.toUpperCase();
  if (!L.startsWith("AT")) return false;
  if (DENY_PREFIX.some(function (p) { return L.startsWith(p); })) return false;
  const assignsValue = L.indexOf("=") >= 0 && !L.endsWith("=?");
  if (assignsValue) return false;
  if (SAFE_EXACT.has(L)) return true;
  return /^AT\+[A-Z]{2,12}\?$/.test(L);
}

/** 防御：剧本被改坏也不至于发出写命令 */
export function sanitizeScript(steps) {
  return steps.filter(function (s) {
    return s.kind !== "send" || s.raw || isAllowedCommand(s.line);
  });
}

/* ------------------------------------------------------------------ *
 * 2. 固定剧本
 * ------------------------------------------------------------------ */

const NET_BEST_EFFORT_NB = ["AT+CSQ", "AT+CFUN?", "AT+CPIN?", "AT+CEREG?", "AT+COPS?", "AT+CGSN", "AT+CIMI", "AT+NBAND?"];

/** 探测：不知道 LoRa 还是 NB 时先跑这几步 */
export function buildProbeScript(opts) {
  const o = opts || {};
  const password = o.password || "";
  const steps = [
    { kind: "listen", ms: 2000, note: "passive-boot" },
    { kind: "send", line: "", waitMs: 300, bestEffort: true, note: "wake" }
  ];
  if (password) steps.push({ kind: "send", line: password, raw: true, waitMs: 900, bestEffort: true, note: "unlock" });
  steps.push({ kind: "send", line: "AT+VER", waitMs: 900, note: "firmware" });
  return sanitizeScript(steps);
}

/** 诊断主剧本：variant 由探测结果决定 */
export function buildPlanScript(variant, opts) {
  const o = opts || {};
  const password = o.password || "";
  const reboot = o.reboot !== false;
  const steps = [];
  if (reboot) {
    steps.push({ kind: "send", line: "ATZ", waitMs: 1200, note: "reboot-for-bootlog" });
    steps.push({ kind: "listen", ms: 3500, note: "boot-log" });
    if (password) steps.push({ kind: "send", line: password, raw: true, waitMs: 900, bestEffort: true, note: "unlock-again" });
  }
  if (variant === "nb") {
    steps.push(
      { kind: "send", line: "AT+DEVID", waitMs: 500, note: "device-id" },
      { kind: "send", line: "AT+PROID", waitMs: 500, note: "product-id" },
      { kind: "send", line: "AT+AUTHINFO", waitMs: 500, note: "auth-info" },
      { kind: "send", line: "AT+SERIP", waitMs: 500, note: "server" },
      { kind: "send", line: "AT+CTANGLE", waitMs: 500, note: "angle-threshold" },
      { kind: "send", line: "AT+ICANGLE", waitMs: 500, note: "compare-angle" },
      { kind: "send", line: "AT+ITYP", waitMs: 500, note: "install-type" },
      { kind: "send", line: "AT+EXTI", waitMs: 500, note: "exti" },
      { kind: "send", line: "AT+TDC", waitMs: 500, note: "tdc" },
      { kind: "send", line: "AT+STDC", waitMs: 500, note: "stdc" },
      { kind: "send", line: "AT+BAT", waitMs: 500, note: "battery" },
      { kind: "send", line: "AT+DATE", waitMs: 500, note: "rtc" }
    );
    NET_BEST_EFFORT_NB.forEach(function (cmd) {
      steps.push({ kind: "send", line: cmd, waitMs: 700, bestEffort: true, note: "network" });
    });
  } else {
    steps.push(
      { kind: "send", line: "AT+CFG", waitMs: 1600, note: "config-dump" },
      { kind: "send", line: "AT+BAT", waitMs: 500, note: "battery" },
      { kind: "send", line: "AT+DATE", waitMs: 500, note: "rtc" },
      { kind: "send", line: "AT+ICANGLE", waitMs: 500, note: "compare-angle" },
      { kind: "send", line: "AT+CTANGLE", waitMs: 500, note: "angle-threshold" },
      { kind: "send", line: "AT+NJS", waitMs: 500, bestEffort: true, note: "join" },
      { kind: "send", line: "AT+RSSI", waitMs: 500, bestEffort: true, note: "rssi" },
      { kind: "send", line: "AT+SNR", waitMs: 500, bestEffort: true, note: "snr" }
    );
  }
  return sanitizeScript(steps);
}

/* ------------------------------------------------------------------ *
 * 3. 解析
 * ------------------------------------------------------------------ */

const toNum = function (v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function lastMatch(re, text) {
  const g = new RegExp(re.source, re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g");
  let m = null;
  let out = null;
  while ((m = g.exec(text)) !== null) {
    out = m;
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return out;
}

export function detectVariant(text) {
  const t = String(text || "");
  if (/DRAGINO\s+TSE\s+NB\s+Device/i.test(t)) return "nb";
  if (/(?:^|\n)\s*TSE\s+Device\s*\r?\n/.test(t)) return "lora";
  if (/Frequency Band:\s*[A-Z]{2}\d{3}/.test(t)) return "lora";
  if (/Device ID=/.test(t) && /AuthInfo=/.test(t)) return "nb";
  if (/AT\+DEUI/.test(t) || /DevEui/i.test(t)) return "lora";
  return "unknown";
}

/** RTC 文本 -> {y4, synced, raw}；兼容 26/9/9 与 2026-09-09 两种形态 */
export function parseRtc(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return { raw: String(raw).trim(), y4: null, synced: false };
  const y = Number(m[1]);
  const y4 = y < 100 ? 2000 + y : y;
  return { raw: String(raw).trim(), y4: y4, month: Number(m[2]), day: Number(m[3]), synced: y4 >= 2024 };
}

function angleFrom(chunk) {
  const m = chunk.match(/Roll\s*[:=]\s*(-?\d+(?:\.\d+)?)\s+Pitch\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  return m ? { roll: Number(m[1]), pitch: Number(m[2]) } : null;
}

function pick(m) {
  return m && m[1] !== undefined ? String(m[1]).trim() : null;
}

export function parseConsole(text) {
  const raw = String(text || "");
  const variant = detectVariant(raw);
  const banners = (raw.match(/DRAGINO\s+TSE\s+NB\s+Device/gi) || []).length +
    (raw.match(/(?:^|\n)\s*TSE\s+Device\s*\r?\n/g) || []).length;

  // 只看最后一次启动块，避免被前一批残留配置带偏（与 QC 脚本同口径）
  const a = raw.lastIndexOf("DRAGINO TSE NB Device");
  const mTail = raw.match(/(?:^|\n)(\s*TSE\s+Device\s*\r?\n[\s\S]*)$/);
  const b = mTail ? raw.length - mTail[1].length : -1;
  const cut = Math.max(a, b);
  const tail = cut > 0 ? raw.slice(cut) : raw;

  const fw = pick(lastMatch(/Image Version:\s*(.+?)\s*$/im, tail)) || pick(lastMatch(/AT\+VER=\s*(.+?)\s*$/im, tail));
  const band = pick(lastMatch(/Frequency Band:\s*(\S+)/i, tail));

  const internalIdx = tail.search(/Internal Comparison Angle/i);
  const beforeInternal = internalIdx > -1 ? tail.slice(0, internalIdx) : tail;
  const afterInternal = internalIdx > -1 ? tail.slice(internalIdx) : "";
  const angle = angleFrom(beforeInternal) || angleFrom(afterInternal);
  const icangle = internalIdx > -1 ? angleFrom(afterInternal) : null;

  const rtcRaw = pick(lastMatch(/(?:^|\n)[ \t]*(?:Time:[ \t]*|AT\+DATE=[ \t]*)([^\r\n]+)/i, tail));

  const csqM = lastMatch(/\+CSQ:\s*(\d+),(\d+)/, raw);
  const tcustom = lastMatch(/AT\+TCUSTOMIZE=\s*(\d+)\s*,\s*(\d+)/, raw);
  const tdcM = lastMatch(/AT\+TDC=\s*(\d+)/, raw);
  const stdcM = lastMatch(/AT\+STDC=\s*(\d+)/, raw);
  const iccidM = lastMatch(/(?:\+NCCID:\s*|ICCID[:=]\s*)(\d{18,22})/i, raw) || lastMatch(/(?<!\d)(\d{19,20})(?!\d)/, raw);

  const identity = {
    deviceId: pick(lastMatch(/Device ID=\s*([0-9A-Za-z]+)/, tail)) || pick(lastMatch(/AT\+DEVID=\s*([0-9A-Za-z]+)/, raw)),
    productId: pick(lastMatch(/Product ID=\s*([0-9A-Za-z]+)/, tail)) || pick(lastMatch(/AT\+PROID=\s*([0-9A-Za-z]+)/, raw)),
    authInfo: pick(lastMatch(/AuthInfo=\s*([0-9A-Za-z]+)/, tail)) || pick(lastMatch(/AT\+AUTHINFO=\s*([0-9A-Za-z]+)/, raw)),
    devEui: pick(lastMatch(/DevEui[:=]\s*([0-9A-Fa-f ]+)/i, raw)),
    appEui: pick(lastMatch(/AppEui[:=]\s*([0-9A-Fa-f ]+)/i, raw))
  };

  const config = {
    server: pick(lastMatch(/Server IP & PORT=\s*(\S+)/, tail)) || pick(lastMatch(/AT\+SERIP=\s*(\S+)/, raw)),
    apn: pick(lastMatch(/(?:^|\n)[ \t]*APN=[ \t]*([^\r\n]*)/m, tail)),
    cops: pick(lastMatch(/(?:^|\n)[ \t]*COPS=[ \t]*([0-9A-Za-z,]*)/m, tail)),
    nband: pick(lastMatch(/\+NBAND:\s*([0-9,\s]+)/, raw)) ? pick(lastMatch(/\+NBAND:\s*([0-9,\s]+)/, raw)).replace(/\s+/g, "") : null,
    stdc: toNum(tcustom ? tcustom[1] : stdcM ? stdcM[1] : null),
    tdc: toNum(tcustom ? tcustom[2] : tdcM ? tdcM[1] : null),
    ctangle: toNum(pick(lastMatch(/AT\+CTANGLE=\s*(-?\d+(?:\.\d+)?)/, raw))),
    ityp: pick(lastMatch(/AT\+ITYP=\s*(\d)/, raw)),
    port: toNum(pick(lastMatch(/AT\+PORT=\s*(\d+)/, raw)))
  };

  const network = {
    csq: csqM ? { rssi: Number(csqM[1]), ber: Number(csqM[2]) } : null,
    cfun: toNum(pick(lastMatch(/\+CFUN:\s*(\d)/, raw))),
    imei: pick(lastMatch(/(?:\+CGSN:\s*|IMEI[:=]\s*)(\d{14,16})/i, raw)),
    imsi: pick(lastMatch(/(?:\+CIMI:\s*|IMSI[:=]\s*)(\d{14,16})/i, raw)),
    iccid: iccidM ? iccidM[1] : null,
    njs: pick(lastMatch(/AT\+NJS=\s*(\d)/, raw)),
    rssi: toNum(pick(lastMatch(/AT\+RSSI=\s*(-?\d+)/, raw))),
    snr: toNum(pick(lastMatch(/AT\+SNR=\s*(-?\d+)/, raw)))
  };

  return {
    variant: variant,
    banners: banners,
    firmware: fw,
    band: band,
    rtc: parseRtc(rtcRaw),
    angle: angle,
    icangle: icangle,
    batteryMv: toNum(pick(lastMatch(/BAT voltage=\s*(\d+)\s*mV/i, raw))) || toNum(pick(lastMatch(/AT\+BAT=\s*(\d+)/, raw))),
    rebootCause: pick(lastMatch(/REBOOT_CAUSE_([A-Z_]+)/i, raw)),
    identity: identity,
    config: config,
    network: network,
    flags: {
      passwordAccepted: /Correct Password/.test(raw),
      passwordRejected: /Incorrect Password/.test(raw),
      error: /(?:^|\n)[ \t]*(?:AT_(?:PARAM_|BUSY_|RX_)?ERROR|ERROR)[ \t]*(?:\r?\n|$)/.test(raw),
      sentinelCsq: !!csqM && Number(csqM[1]) === 99,
      tailChars: tail.length
    },
    raw: raw
  };
}

/* ------------------------------------------------------------------ *
 * 4. 判定
 * ------------------------------------------------------------------ */

export const DEFAULT_THRESHOLDS = {
  batteryWarn: 3450,
  batteryFail: 3300,
  angleSentinel: 179,
  firmwareMinYear: 2024
};

function item(id, level, value, extra) {
  const o = { id: id, level: level, value: value === undefined ? null : value };
  if (extra) Object.assign(o, extra);
  return o;
}

export function evaluate(report, opts) {
  const o = opts || {};
  const profile = o.profile || {};
  // locked = 本次没有确认解锁 AT：需要"问设备"才拿得到的项一律标 skip，不许当成异常
  const locked = !!o.locked;
  const th = Object.assign({}, DEFAULT_THRESHOLDS, o.thresholds || {});
  const groups = [];
  const R = report || {};
  const idy = R.identity || {};
  const cfg = R.config || {};
  const net = R.network || {};
  const hasProfile = Object.keys(profile).length > 0;

  /* 识别 */
  const ident = [
    item("v.detect", R.variant === "unknown" ? "fail" : "pass", R.variant),
    item("v.firmware", R.firmware ? "pass" : "warn", R.firmware)
  ];
  groups.push({ id: "identity", items: ident });

  /* 身份值 */
  const idItems = [];
  if (R.variant === "nb") {
    idItems.push(item("id.deviceId", !idy.deviceId || idy.deviceId === "1234567890" ? "fail" : "pass", idy.deviceId, { masked: true }));
    idItems.push(item("id.authInfo", !idy.authInfo || idy.authInfo === "0000" ? "fail" : "pass", idy.authInfo, { masked: true }));
    idItems.push(item("id.productId", !idy.productId ? "fail" : idy.productId === "0000" ? "warn" : "pass", idy.productId));
  } else if (R.variant === "lora") {
    const allZero = idy.devEui && /^(?:00[ ]?){8}$/.test(idy.devEui.replace(/=+/g, "").trim());
    idItems.push(item("id.devEui", !idy.devEui || allZero ? "fail" : "pass", idy.devEui, { masked: true }));
  }
  groups.push({ id: "identityVals", items: idItems });

  /* 配置 */
  const cfgItems = [];
  if (R.variant === "nb") {
    // 服务器地址是 NB 专有字段；LoRaWAN 没有这个配置项
    const serverDefault = !cfg.server || cfg.server === "0.0.0.0,0";
    const serverItem = item("cfg.server", serverDefault ? "fail" : "pass", cfg.server);
    if (profile.server) {
      serverItem.expected = profile.server;
      serverItem.level = cfg.server === profile.server ? "pass" : "fail";
    }
    cfgItems.push(serverItem);

    const apnItem = item("cfg.apn", cfg.apn ? "pass" : "fail", cfg.apn);
    if (profile.apn) { apnItem.expected = profile.apn; apnItem.level = cfg.apn === profile.apn ? "pass" : "fail"; }
    cfgItems.push(apnItem);

    const copsItem = item("cfg.cops", cfg.cops ? "pass" : "fail", cfg.cops);
    if (profile.cops) { copsItem.expected = profile.cops; copsItem.level = cfg.cops === profile.cops ? "pass" : "fail"; }
    cfgItems.push(copsItem);

    const bandItem = item("cfg.nband", cfg.nband ? "pass" : locked ? "skip" : "warn", cfg.nband);
    if (profile.nband) { bandItem.expected = profile.nband; bandItem.level = cfg.nband === profile.nband ? "pass" : "fail"; }
    cfgItems.push(bandItem);
  }

  const intervals = cfg.tdc && cfg.stdc ? cfg.stdc + " / " + cfg.tdc : null;
  let intLevel = "pass";
  if (!cfg.tdc || !cfg.stdc) intLevel = locked ? "skip" : "warn";
  else if (cfg.tdc % cfg.stdc !== 0) intLevel = "warn";
  const intItem = item("cfg.intervals", intLevel, intervals);
  if (profile.tdc || profile.stdc) {
    intItem.expected = (profile.stdc || "?") + " / " + (profile.tdc || "?");
    intItem.level = (!profile.tdc || Number(profile.tdc) === cfg.tdc) && (!profile.stdc || Number(profile.stdc) === cfg.stdc) ? "pass" : "fail";
  }
  cfgItems.push(intItem);

  const ctItem = item("cfg.ctangle", cfg.ctangle === null ? (locked ? "skip" : "warn") : "pass", cfg.ctangle);
  if (profile.ctangle !== undefined) { ctItem.expected = profile.ctangle; ctItem.level = Number(cfg.ctangle) === Number(profile.ctangle) ? "pass" : "fail"; }
  cfgItems.push(ctItem);

  if (R.variant === "nb") {
    const itItem = item("cfg.ityp", cfg.ityp === null ? (locked ? "skip" : "warn") : "pass", cfg.ityp);
    if (profile.ityp !== undefined) { itItem.expected = profile.ityp; itItem.level = String(cfg.ityp) === String(profile.ityp) ? "pass" : "fail"; }
    cfgItems.push(itItem);
  }
  groups.push({ id: "config", items: cfgItems });

  /* 电源 */
  const pwr = [];
  if (R.batteryMv === null || R.batteryMv === undefined) pwr.push(item("pwr.battery", locked ? "skip" : "warn", null));
  else {
    const lvl = R.batteryMv < th.batteryFail ? "fail" : R.batteryMv < th.batteryWarn ? "warn" : "pass";
    pwr.push(item("pwr.battery", lvl, R.batteryMv, { unit: "mV" }));
  }
  groups.push({ id: "power", items: pwr });

  /* 传感器 */
  const sen = [];
  if (!R.angle) sen.push(item("sen.angle", "warn", null));
  else {
    const a = R.angle;
    const bothNear = Math.abs(Math.abs(a.roll) - Math.abs(a.pitch)) < 0.6;
    const sentinel = bothNear && Math.abs(a.roll) >= th.angleSentinel && Math.abs(a.pitch) >= th.angleSentinel;
    sen.push(item("sen.angle", sentinel ? "fail" : "pass", a.roll + " / " + a.pitch, { unit: "°" }));
  }
  if (!R.icangle) sen.push(item("sen.icangle", locked ? "skip" : "warn", null));
  else sen.push(item("sen.icangle", "pass", R.icangle.roll + " / " + R.icangle.pitch, { unit: "°" }));

  if (R.angle && R.icangle) {
    const dRoll = Math.abs(R.angle.roll - R.icangle.roll);
    const dPitch = Math.abs(R.angle.pitch - R.icangle.pitch);
    const dMax = Math.max(dRoll, dPitch);
    const ct = Number.isFinite(cfg.ctangle) ? cfg.ctangle : null;
    const lvl = ct !== null && dMax > ct ? "warn" : "pass";
    sen.push(item("sen.alarmDiff", lvl, dMax.toFixed(2), { unit: "°", expected: ct }));
  }
  groups.push({ id: "sensor", items: sen });

  /* 时间 / 重启 */
  const timeItems = [];
  if (!R.rtc) timeItems.push(item("time.rtc", "warn", null));
  else if (R.rtc.y4 === null) timeItems.push(item("time.rtc", "warn", R.rtc.raw));
  else timeItems.push(item("time.rtc", R.rtc.y4 >= th.firmwareMinYear ? "pass" : "warn", R.rtc.raw));
  timeItems.push(item("time.rebootCause", R.rebootCause ? "pass" : "skip", R.rebootCause));
  groups.push({ id: "time", items: timeItems });

  /* 网络 */
  const netItems = [];
  if (R.variant === "nb") {
    if (!net.csq) netItems.push(item("net.csq", locked ? "skip" : "warn", null));
    else if (net.csq.rssi === 99) netItems.push(item("net.csq", "warn", "99,99"));
    else netItems.push(item("net.csq", net.csq.rssi >= 10 ? "pass" : "warn", net.csq.rssi + "," + net.csq.ber));
    if (net.cfun !== null && net.cfun !== undefined) netItems.push(item("net.cfun", net.cfun === 1 ? "pass" : "fail", net.cfun));
    netItems.push(item("net.imei", net.imei ? "pass" : "skip", net.imei, { masked: true }));
    netItems.push(item("net.iccid", net.iccid ? "pass" : "skip", net.iccid, { masked: true }));
  } else if (R.variant === "lora") {
    netItems.push(item("net.join", net.njs === "1" ? "pass" : net.njs === "0" ? "warn" : "skip", net.njs));
    netItems.push(item("net.rssi", net.rssi === null ? "skip" : net.rssi > -120 ? "pass" : "warn", net.rssi));
  }
  groups.push({ id: "network", items: netItems });

  /* 日志质量 */
  groups.push({
    id: "log",
    items: [
      item("log.password", R.flags && R.flags.passwordAccepted ? "pass" : R.flags && R.flags.passwordRejected ? "warn" : "skip", null),
      item("log.errors", R.flags && R.flags.error ? "fail" : "pass", null)
    ]
  });

  /* 汇总 */
  const flat = groups.reduce(function (acc, g) { return acc.concat(g.items); }, []);
  const counts = { fail: 0, warn: 0, pass: 0, skip: 0 };
  flat.forEach(function (it) { counts[it.level] = (counts[it.level] || 0) + 1; });
  const verdict = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  const top = flat.filter(function (it) { return it.level === "fail" || it.level === "warn"; })
    .slice(0, 5).map(function (it) { return it.id; });
  return { verdict: verdict, counts: counts, groups: groups, top: top, profileUsed: hasProfile, locked: locked };
}

export function maskValue(v, visible) {
  const n = visible === undefined ? 3 : visible;
  if (v === null || v === undefined) return "—";
  const s = String(v);
  if (s.length <= n) return s;
  return "…" + s.slice(-n);
}

export function buildResult(report, verdict, meta) {
  return {
    app: "LiFY-T device diag",
    version: APP_VERSION,
    generatedAt: new Date().toISOString(),
    meta: meta || {},
    verdict: verdict.verdict,
    counts: verdict.counts,
    variant: report.variant,
    firmware: report.firmware,
    groups: verdict.groups,
    raw: report.raw
  };
}
