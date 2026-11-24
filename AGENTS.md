# Agent Instructions — lifyt_device_diag

本仓库是「USB-TTL 直连设备诊断」的纯前端工具。改动前先读 `POSITIONING.md`（边界）和
`docs/protocol-notes.md`（协议事实与来源）。

## 硬规则

1. **剧本里不许出现写命令**。任何 `AT+XXX=值` 都会被 `isAllowedCommand()` 拒绝；新增命令必须
   ①先加进 `core.js` 的 `SAFE_EXACT` ②在 `docs/protocol-notes.md` 写明来源（哪份手册/哪条日志证据）。
   永不加入：`AT+FDR`、`AT+DISAT`、`AT+SIMLOCK`、`AT+CICANGLE`、`AT+PWRITE/`AT+PWORD` 这类。
2. **改判定必须同时改测试**。新增/调整判定项 → 在 `tests/fixtures/` 加或改合成日志 → 在
   `tests/replay.test.mjs` 断言 level；三语标签在 `index.html` 补齐（`tests/page.test.mjs` 会兜）。
3. **不要用真实凭证做夹具**。fixtures 里的 Device ID / AuthInfo / IMEI / ICCID 一律用明显合成的号段
   （`8699300000000xx`、`LFTAN000xxHWsy`、`898600000000000000xx`）。日志里出现真实凭证时只谈匹配与否。
4. **真机没验证的字段不要加重判定**。`docs/protocol-notes.md` 的「待真机确认」清单没清掉之前，
   相关项保持 `warn/skip`，不要升级成 `fail`。
5. **保持"客户只看结果"**：页面不提供自由命令输入框；高级面板只放波特率、重启开关、序列号显示、期望值 JSON（密码不在这里，见规则 7）。
6. **不引外链**。单页、无 CDN、无远程脚本（`tests/page.test.mjs` 会拦，允许同源的 config*.js）。
7. **AT 密码只走 `config.local.js`**（已 gitignore）：不进 UI、不进日志、不进 fixtures、不提交。
   密码在这里不是密钥（纯前端 F12 就能看），但也不许摆到界面或文档里。
8. **"未解锁 ≠ 设备异常"**：`evaluate(report, { locked })` 里，需要查询才拿得到的项（电池、间隔、
   阈值、安装方式、频段、CSQ、ICCID）在未解锁时必须是 `skip`，不许降级成 `warn/fail`。
   这条由 `tests/replay.test.mjs` 的「没解锁时不把『没读到』当成异常」守着。

## 与 signal_tester 的关系

连接层（CH340 WebUSB 驱动、open 重试、读流）是从 `signal_tester/3-webusb/index.html` 移植的。
那边如果改了驱动，这里要跟一次，并更新 `POSITIONING.md` 的差异表。

## 验证

```powershell
node tests/replay.test.mjs
node tests/page.test.mjs
python -m http.server 8771   # 人工看页面
```

本仓库没有构建步骤、没有包依赖；`package.json` 只用于 `"type": "module"` 和测试入口。
