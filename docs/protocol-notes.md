# 设备控制台协议笔记

本文记录诊断剧本与解析所依赖的**设备事实**及其来源。改判定/改剧本前请先读。

## 1. 物理与串口

| 事实 | 值 | 来源 |
|---|---|---|
| 调试串口位置 | 板子**右上角 3 针**（TXD/RXD/GND），与客户远程配置接线相同 | `lify-t/doc/for_client/instruction/NB-IoT_Configuration_Guide_Universal.docx` |
| 串口参数 | 9600 8N1，行尾 `\\r\\n` | `lify-t/doc/AT_Command_Manual_EN_lora.md` §2（vcom.c） |
| USB-TTL 适配器 | CH340（VID 0x1a86 / PID 0x7523）；CH343 属 CDC | signal_tester `3-webusb/index.html` 注释与实测记录 |
| 固件更新口 | 另一处 4-pin SWD（GND/NRST/CLK/DIO），走 ST-LINK，不用于诊断 | 同上 dociument 附录 |

## 2. AT 解锁

设备启动后打印 `Enter Password to Active AT Commands`，之后**裸发密码行**（不是 `AT+PWORD=`）
才会出现 `Correct Password`；错误则为 `Incorrect Password`。

证据：产线 QC 日志中 `[Tx] 83724` → `[Rx] Correct Password`，随后 `AT+CFG` 才有回显。

- 剧本里密码作为 `raw` 步骤发送，不经过白名单（它本来就不是 AT 命令）
- 密码来源：`config.js` → 页面内存；不进 UI、不进日志
- 密码换过了就更新这个文件；不填 = 只做免解锁检查

### 2.1 免解锁能拿到什么（真实产线日志，密码门前那 21 行）

```
DRAGINO TSE NB Device      Image Version: TSE NB v1.4 …
Time: …                    Angle / Internal Comparison Angle
Device ID=  Product ID=  AuthInfo=  APN=  COPS=  Server IP & PORT=
REBOOT_CAUSE_APPLICATION_AT        +CSQ:13,99 Query whether the network is activated?
```

| 免解锁可得 | 解锁才可得 |
|---|---|
| 型号、固件版本、RTC、当前角度、内部对比角、Device ID、Product ID、AuthInfo、APN、COPS、服务器地址、重启原因、CSQ | 电池电压（`AT+BAT`）、IMEI（`AT+CGSN`）、ICCID、采集/上报间隔（`AT+STDC`/`AT+TDC`）、角度阈值（`AT+CTANGLE`）、安装方式（`AT+ITYP`）、CFUN、NBAND |

判定口径：**没有 `Correct Password` 就视为 locked**，上表右侧那些项一律 `skip / 未检查`，
不参与 PASS/WARN/FAIL 汇总，页面顶部挂提示。这条是硬规则，理由是"没测"和"测了不合格"必须区分开。

## 3. 变体与命令集

| | TSE NB（BC95-GV / OneNET） | TSE LoRaWAN |
|---|---|---|
| 启动横幅 | `DRAGINO TSE NB Device` | `TSE Device` + `Frequency Band: EU868` |
| 命令清单来源 | `lify-t/doc/AT_Command_List_NB.txt`（fw v1.3） | `lify-t/doc/AT_Command_Manual_EN_lora.md`（TSE v2.4） |
| 特有查询 | `AT+DEVID` `AT+PROID` `AT+AUTHINFO` `AT+SERIP` `AT+ITYP` | `AT+CFG`（全量转储）`AT+NJS` `AT+RSSI` `AT+SNR` |
| 共用查询 | `AT+VER` `AT+BAT` `AT+DATE` `AT+CTANGLE` `AT+ICANGLE` `AT+TDC` `AT+STDC` | 同左 |
| 网络侧字段 | `+CSQ` `+CFUN` `+NBAND` `+CGSN`(IMEI) `+NCCID`(ICCID) | `AT+NJS` `AT+RSSI` `AT+SNR` |

NB 固件**没有 `AT+CFG`**（命令清单里没有），所以 NB 走逐项查询 + 启动块转储两条路取证；
LoRa 固件有 `AT+CFG`，一次就能拿到 `AT+DEUI/AT+APPKEY/AT+TDC/AT+CTANGLE/AT+BAT` 全量。

## 4. 启动块字段（NB，脱敏样例）

```
DRAGINO TSE NB Device
Image Version: TSE NB v1.4 260826
Time: 26/11/20 09:12:44
Angle
Roll=-90.35 Pitch=107.50
Internal Comparison Angle
Roll:-90.12 Pitch:107.33
Device ID= <10 位>
Product ID= <4 位>
AuthInfo= <字母数字>
APN= cmhk
COPS= 45412
Server IP & PORT= <ip>,<port>
REBOOTING
REBOOT_CAUSE_APPLICATION_AT
```

- 出厂默认：`Device ID= 1234567890`、`Product ID= 0000`、`AuthInfo= 0000`、`Server IP & PORT= 0.0.0.0,0`、`Time: 0/1/1` 或 `21/1/29`
- 一次会话里可能出现多个启动块（重启、重复上电）；**只认最后一个**（与 `check_logs.py` 同口径）
- `REBOOT_CAUSE_*` 是设备自报的重启原因（`APPLICATION_AT`、`POWER_ON`、`WATCHDOG` 等），只作证据不作判据

### 角度与对比角

`Angle` 块给当前 Roll/Pitch；`Internal Comparison Angle` 块给内部对比角。
偏差超过 `AT+CTANGLE` 阈值时，设备下一次上报就会触发倾斜警报——这是"装完忘重置对比角"
的典型坑，所以诊断把 `|Δ| > CTANGLE` 判为**提示**而不是失败。

IMU 失效的典型指纹：`Roll=179.29 Pitch=179.29`（两轴几乎相等且接近 180）。判据：
`||roll|-|pitch|| < 0.6` 且两者 `>= 179` → fail。

## 5. 阈值来源

| 阈值 | 值 | 依据 |
|---|---|---|
| 电池提示 | 3450 mV | 3.6 V 锂亚硫酰氯标称，实测健康设备 3600–3700 mV |
| 电池失败 | 3300 mV | 低于此值 NB 发射（峰值 ~250 mA）易掉电重启 |
| RTC 未同步 | 年份 < 2024 | 设备掉电后 RTC 回到 0/1/1 或 21/1/29 |

阈值集中定义在 `core.js` 的 `DEFAULT_THRESHOLDS`，改之前先补夹具断言。

## 5.1 真机实测补充（v1.3 231218 / v1.4 260623）

| 结论 | 证据 |
|---|---|
| `AT+ITYP=?` **不支持**（两版固件都回 AT_ERROR） | 2026-11-26 两次真机会话；已从剧本移除 |
| `AT+CGSN` 回的是**模组序列号**（如 `MPY26FG6D005054`），不是 IMEI | 同上；报告里单列「模块序列号」 |
| ICCID 用 `AT+NCCID` 读（启动块不打印） | 同上 |
| 角度是环形的：`-148.93` 与 `111.89` 相差 99.18°，不是 260.82° | 判定已按 `min(d, 360-d)` |
| ATZ 后设备要跑完「配 APN → 配 COPS → 每 5 秒轮询 CSQ → 入网 → 首包 ACK」，约 25–60 秒；**这期间发的 AT 会被吞** | 2026-11-26 16:14 / 16:26 两次日志 |
| 解锁必须验证：发密码后要看到 `Correct Password`，否则重试 | 16:14 那次 20 条命令全回 `Incorrect Password` |

## 6. 待真机确认（打完勾才可提高判定强度）

- [ ] NB 固件查询的**回显形态**：是 `AT+CTANGLE=10` 这种带前缀，还是解锁后返回一串**裸值**（QC 日志显示是后者）
- [ ] 解锁后是否所有查询都需要密码，还是只有写命令需要
- [ ] `ATZ` 重启后串口是否掉线（CH340 侧是否仍保持打开）
- [ ] 9600 是否为 NB 变体的实际波特率（LoRa 手册写明 9600，NB 手册未写）
- [ ] `AT+CSQ` / `AT+CGSN` 等模组命令是**固件透传**还是需要别的写法
- [ ] `+NBAND` 查询是否要在密码后立刻发（QC 日志里它在查询序列里出现）

在这些打勾之前，相关项在 `core.js` 里保持 `warn/skip`，不要升级为 `fail`。
