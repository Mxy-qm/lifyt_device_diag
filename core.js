/**
 * core.js — 设备诊断内核：协议事实、固定剧本、日志解析、判定规则。
 *
 * 设计约束（alpha）：
 *  1. 剧本只允许查询类命令：任何带 "=<值>" 的写入命令在 isAllowedCommand() 处直接被拒。
 *  2. 解析器不猜：字段全部来自设备控制台真实输出（来源见 docs/protocol-notes.md）。
 *  3. 本文件不碰 DOM，浏览器与 node 测试共用。
 */

export const APP_VERSION = "0.1.6-alpha";

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
  if (/^AT\+[A-Z]{2,12}=\?$/.test(L)) return true; // NB 固件的 "Get the value" 形态
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
    { kind: "listen", ms: 1200, note: "passive-boot" },
    { kind: "send", line: "", raw: true, waitMs: 300, bestEffort: true, note: "wake" }
  ];
  if (password) steps.push({ kind: "send", line: password, raw: true, waitMs: 700, bestEffort: true, note: "unlock" });
  // 重启拿完整启动块：设备型号、固件、身份、配置、角度、重启原因都在这一段里
  steps.push({ kind: "send", line: "ATZ", waitMs: 600, note: "reboot" });
  steps.push({ kind: "listen", ms: 2500, note: "boot-block" });
  return sanitizeScript(steps);
}

/** 重启之后重新解锁（ATZ 会把 AT 门重新锁上） */
export function buildUnlockScript(password) {
  if (!password) return [];
  return [{ kind: "send", line: password, raw: true, waitMs: 700, bestEffort: true, note: "unlock-again" }];
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
    // NB 固件（fw v1.3+）的取值为 AT+X=?；真机 v1.4 上裸写 AT+X 返回 AT_ERROR，故带 bare 备选
    const q = (cmd, note, waitMs) => ({ kind: "send", line: "AT+" + cmd + "=?", alt: "AT+" + cmd, waitMs: waitMs || 600, note: note });
    steps.push(
      q("VER", "firmware"),
      q("DEVID", "device-id"),
      q("PROID", "product-id"),
      q("AUTHINFO", "auth-info"),
      q("SERIP", "server"),
      q("CTANGLE", "angle-threshold"),
      q("ICANGLE", "compare-angle"),
      q("ITYP", "install-type"),
      q("EXTI", "exti"),
      q("TDC", "tdc"),
      q("STDC", "stdc"),
      q("BAT", "battery"),
      q("DATE", "rtc")
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

/** 去掉各种日志前缀（界面里的 ← / →、旧日志的 [Rx][10:28:13.307]、内部提示行），只留设备原文 */
export function stripLogDecorations(text) {
  return String(text || "")
    .replace(/^[ \t]*\[(?:Rx|Tx)\](?:\[[^\]]*\])?[ \t]*/gmi, "")
    .replace(/^[ \t]*→[ \t]?/gm, "TX> ")
    .replace(/^[ \t]*←[ \t]?/gm, "")
    .replace(/^[ \t]*\[(?:sys|skip|warn|error|open|read)\][^\n]*$/gmi, "");
}

/** 只留设备输出（去掉 TX> 行），用于字段解析 */
export function deviceOutput(text) {
  return stripLogDecorations(text).replace(/^[ \t]*TX>[^\n]*$/gm, "");
}

export function parseConsole(text) {
  const all = stripLogDecorations(text);
  const raw = all.replace(/^[ \t]*TX>[^\n]*$/gm, "");
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
    // IMSI：优先 +CIMI 回显，其次用启动块里单独打印的那行 15 位号（固件会直接打出来）
    imsi: pick(lastMatch(/(?:\+CIMI:\s*|IMSI[:=]\s*)(\d{14,16})/i, raw)) || pick(lastMatch(/(?:^|\n)[ \t]*(\d{15})[ \t]*(?=\r?\n)/, tail)),
    iccid: iccidM ? iccidM[1] : null,
    njs: pick(lastMatch(/AT\+NJS=\s*(\d)/, raw)),
    cereg: (function () {
      const m = lastMatch(/\+CEREG:\s*(\d+),(\d+)/, raw);
      return m ? { n: Number(m[1]), stat: Number(m[2]) } : null;
    })(),
    rssi: toNum(pick(lastMatch(/AT\+RSSI=\s*(-?\d+)/, raw))),
    snr: toNum(pick(lastMatch(/AT\+SNR=\s*(-?\d+)/, raw)))
  };

  // 区分"设备没回这个字段"和"设备回了但值是空的"——前者是没测到，后者才是异常
  const seen = {
    apn: /(?:^|\n)[ \t]*APN=/.test(tail),
    cops: /(?:^|\n)[ \t]*COPS=/.test(tail),
    server: /Server IP & PORT=/.test(tail) || /AT\+SERIP=/.test(raw),
    time: /(?:^|\n)[ \t]*(?:Time:|AT\+DATE=)/i.test(tail),
    battery: /BAT voltage=|AT\+BAT[=:]/.test(raw),
    ctangle: /AT\+CTANGLE[=:]/.test(raw),
    intervals: /AT\+(?:TDC|STDC|TCUSTOMIZE)[=:]/.test(raw),
    ityp: /AT\+ITYP[=:]/.test(raw),
    nband: /\+NBAND:/.test(raw),
    csq: /\+CSQ:/.test(raw),
    imei: /(?:\+CGSN:|IMEI[:=])/i.test(raw),
    iccid: /(?:\+NCCID:|ICCID[:=])/i.test(raw) || /(?<!\d)\d{19,20}(?!\d)/.test(raw),
    cimi: /AT\+CIMI|\+CIMI:/.test(all),
    cereg: /\+CEREG:/.test(raw),
    angle: /Roll\s*[:=]/.test(tail),
    icangle: /Internal Comparison Angle/i.test(tail)
  };

  return {
    variant: variant,
    banners: banners,
    seen: seen,
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
      cimiError: /TX> AT\+CIMI[^\n]*\n(?:[^\n]*\n){0,3}?\s*ERROR/i.test(all) || /\+CIMI:\s*ERROR/i.test(all),
      passwordAccepted: /Correct Password/.test(raw),
      passwordRejected: /Incorrect Password/.test(raw),
      error: /(?:^|\n)[ \t]*AT_(?:PARAM_|BUSY_|RX_)?ERROR[ \t]*(?:\r?\n|$)/.test(raw),
      moduleError: /(?:^|\n)[ \t]*ERROR[ \t]*(?:\r?\n|$)/.test(raw),
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
  // locked = 本次没有确认解锁 AT
  const locked = !!o.locked;
  const th = Object.assign({}, DEFAULT_THRESHOLDS, o.thresholds || {});
  const groups = [];
  const R = report || {};
  const idy = R.identity || {};
  const cfg = R.config || {};
  const net = R.network || {};
  const seen = R.seen || {};
  const hasProfile = Object.keys(profile).length > 0;

  // 没读到 -> skip，并说明原因：locked（没解锁）或 unread（设备没回这个查询）
  const skip = function (id, value) {
    return item(id, "skip", value === undefined ? null : value, { reason: locked ? "locked" : "unread" });
  };

  /* 识别 */
  groups.push({
    id: "identity",
    items: [
      item("v.detect", R.variant === "unknown" ? "fail" : "pass", R.variant),
      R.firmware ? item("v.firmware", "pass", R.firmware) : skip("v.firmware")
    ]
  });

  /* 身份值 */
  const idItems = [];
  if (R.variant === "nb") {
    idItems.push(item("id.deviceId", !idy.deviceId || idy.deviceId === "1234567890" ? "fail" : "pass", idy.deviceId));
    idItems.push(item("id.authInfo", !idy.authInfo || idy.authInfo === "0000" ? "fail" : "pass", idy.authInfo));
    idItems.push(item("id.productId", !idy.productId ? "fail" : idy.productId === "0000" ? "warn" : "pass", idy.productId));
  } else if (R.variant === "lora") {
    const allZero = idy.devEui && /^(?:00[ ]?){8}$/.test(idy.devEui.replace(/=+/g, "").trim());
    idItems.push(item("id.devEui", !idy.devEui || allZero ? "fail" : "pass", idy.devEui));
  }
  groups.push({ id: "identityVals", items: idItems });

  /* 配置 */
  const cfgItems = [];
  if (R.variant === "nb") {
    if (!seen.server) cfgItems.push(skip("cfg.server"));
    else {
      const serverDefault = !cfg.server || cfg.server === "0.0.0.0,0";
      const it = item("cfg.server", serverDefault ? "fail" : "pass", cfg.server);
      if (profile.server) { it.expected = profile.server; it.level = cfg.server === profile.server ? "pass" : "fail"; }
      cfgItems.push(it);
    }
    if (!seen.apn) cfgItems.push(skip("cfg.apn"));
    else {
      const it = item("cfg.apn", cfg.apn ? "pass" : "fail", cfg.apn);
      if (profile.apn) { it.expected = profile.apn; it.level = cfg.apn === profile.apn ? "pass" : "fail"; }
      cfgItems.push(it);
    }
    if (!seen.cops) cfgItems.push(skip("cfg.cops"));
    else {
      const it = item("cfg.cops", cfg.cops ? "pass" : "fail", cfg.cops);
      if (profile.cops) { it.expected = profile.cops; it.level = cfg.cops === profile.cops ? "pass" : "fail"; }
      cfgItems.push(it);
    }
    if (!seen.nband) cfgItems.push(skip("cfg.nband"));
    else {
      const it = item("cfg.nband", cfg.nband ? "pass" : "warn", cfg.nband);
      if (profile.nband) { it.expected = profile.nband; it.level = cfg.nband === profile.nband ? "pass" : "fail"; }
      cfgItems.push(it);
    }
  }
  if (!seen.intervals) cfgItems.push(skip("cfg.intervals"));
  else {
    const intervals = cfg.tdc && cfg.stdc ? cfg.stdc + " / " + cfg.tdc : null;
    let lvl = "pass";
    if (!cfg.tdc || !cfg.stdc) lvl = "warn";
    else if (cfg.tdc % cfg.stdc !== 0) lvl = "warn";
    const it = item("cfg.intervals", lvl, intervals);
    if (profile.tdc || profile.stdc) {
      it.expected = (profile.stdc || "?") + " / " + (profile.tdc || "?");
      it.level = (!profile.tdc || Number(profile.tdc) === cfg.tdc) && (!profile.stdc || Number(profile.stdc) === cfg.stdc) ? "pass" : "fail";
    }
    cfgItems.push(it);
  }
  if (!seen.ctangle) cfgItems.push(skip("cfg.ctangle"));
  else {
    const it = item("cfg.ctangle", cfg.ctangle === null ? "warn" : "pass", cfg.ctangle);
    if (profile.ctangle !== undefined) { it.expected = profile.ctangle; it.level = Number(cfg.ctangle) === Number(profile.ctangle) ? "pass" : "fail"; }
    cfgItems.push(it);
  }
  if (R.variant === "nb") {
    if (!seen.ityp) cfgItems.push(skip("cfg.ityp"));
    else {
      const it = item("cfg.ityp", cfg.ityp === null ? "warn" : "pass", cfg.ityp);
      if (profile.ityp !== undefined) { it.expected = profile.ityp; it.level = String(cfg.ityp) === String(profile.ityp) ? "pass" : "fail"; }
      cfgItems.push(it);
    }
  }
  groups.push({ id: "config", items: cfgItems });

  /* 电源 */
  const pwr = [];
  if (!seen.battery) pwr.push(skip("pwr.battery"));
  else if (R.batteryMv === null || R.batteryMv === undefined) pwr.push(item("pwr.battery", "warn", null));
  else {
    const lvl = R.batteryMv < th.batteryFail ? "fail" : R.batteryMv < th.batteryWarn ? "warn" : "pass";
    pwr.push(item("pwr.battery", lvl, R.batteryMv, { unit: "mV" }));
  }
  groups.push({ id: "power", items: pwr });

  /* 传感器 */
  const sen = [];
  if (!R.angle) sen.push(skip("sen.angle"));
  else {
    const a = R.angle;
    const bothNear = Math.abs(Math.abs(a.roll) - Math.abs(a.pitch)) < 0.6;
    const sentinel = bothNear && Math.abs(a.roll) >= th.angleSentinel && Math.abs(a.pitch) >= th.angleSentinel;
    sen.push(item("sen.angle", sentinel ? "fail" : "pass", a.roll + " / " + a.pitch, { unit: "°" }));
  }
  if (!R.icangle) sen.push(skip("sen.icangle"));
  else sen.push(item("sen.icangle", "pass", R.icangle.roll + " / " + R.icangle.pitch, { unit: "°" }));

  if (R.angle && R.icangle) {
    const dMax = Math.max(Math.abs(R.angle.roll - R.icangle.roll), Math.abs(R.angle.pitch - R.icangle.pitch));
    const ct = Number.isFinite(cfg.ctangle) ? cfg.ctangle : null;
    if (ct !== null) {
      sen.push(item("sen.alarmDiff", dMax > ct ? "warn" : "pass", dMax.toFixed(2), { unit: "°", expected: ct }));
    } else if (dMax > 20) {
      // 阈值没读到，但差值明显大：按提示给出，别静默
      sen.push(item("sen.alarmDiff", "warn", dMax.toFixed(2), { unit: "°" }));
    } else {
      sen.push(skip("sen.alarmDiff", dMax.toFixed(2)));
    }
  }
  groups.push({ id: "sensor", items: sen });

  /* 时间 / 重启 */
  const timeItems = [];
  if (!R.rtc) timeItems.push(skip("time.rtc"));
  else if (R.rtc.y4 === null) timeItems.push(item("time.rtc", "warn", R.rtc.raw));
  else timeItems.push(item("time.rtc", R.rtc.y4 >= th.firmwareMinYear ? "pass" : "warn", R.rtc.raw));
  timeItems.push(item("time.rebootCause", R.rebootCause ? "pass" : "skip", R.rebootCause));
  groups.push({ id: "time", items: timeItems });

  /* 网络 */
  const netItems = [];
  if (R.variant === "nb") {
    if (!seen.csq) netItems.push(skip("net.csq"));
    else if (!net.csq) netItems.push(item("net.csq", "warn", null));
    else if (net.csq.rssi === 99) netItems.push(item("net.csq", "warn", "99,99"));
    else netItems.push(item("net.csq", net.csq.rssi >= 10 ? "pass" : "warn", net.csq.rssi + "," + net.csq.ber));
    if (net.cfun !== null && net.cfun !== undefined) netItems.push(item("net.cfun", net.cfun === 1 ? "pass" : "fail", net.cfun));
    if (net.cereg) netItems.push(item("net.reg", net.cereg.stat === 1 || net.cereg.stat === 5 ? "pass" : "warn", "stat " + net.cereg.stat));
    else netItems.push(skip("net.reg"));
    if (net.imsi) netItems.push(item("net.sim", "pass", net.imsi));
    else if (seen.cimi) netItems.push(item("net.sim", "warn", null));
    else netItems.push(skip("net.sim"));
    netItems.push(net.imei ? item("net.imei", "pass", net.imei) : skip("net.imei"));
    netItems.push(net.iccid ? item("net.iccid", "pass", net.iccid) : skip("net.iccid"));
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
      item("log.errors", R.flags && R.flags.error ? "warn" : "pass", null)
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
