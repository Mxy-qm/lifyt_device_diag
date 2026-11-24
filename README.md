# lifyt_device_diag · 设备诊断（USB-TTL 直连）

USB-TTL 接到 LiFY-T 树传感器的串口，网页自动跑一套**固定诊断剧本**，直接给出
PASS / WARN / FAIL、分组明细和可复制的报告。客户只需要插线、点一次按钮、看结论。

- 变体：TSE NB（BC95-GV / OneNET）与 TSE LoRaWAN（Pixel/TrackCentral 侧），**自动识别**
- 连接：CH340 用 WebUSB 直驱（手机 OTG / 台式机都能用）；Web Serial 作为桌面兜底
- 判定：以设备控制台的真实输出为准，不猜；期望值可选（配置里给就从"结构性判定"升级为"逐项比对"）
- 形态：纯前端单页，不联网、不上传日志

## 仓库

- 远端：<https://github.com/Mxy-qm/lifyt_device_diag>（**私有**）
- 默认分支：`main`
- 克隆：`git clone https://github.com/Mxy-qm/lifyt_device_diag.git`
- 只有静态文件，没有构建步骤、没有包依赖；部署时把仓库根目录当站点根即可（要求 HTTPS）

## 快速开始

```powershell
cd lifyt_device_diag
python -m http.server 8771        # 或双击 serve.cmd
# 浏览器打开 http://127.0.0.1:8771
# 端口被占用就换一个（本机 8765 已被别的服务占着）
```

WebUSB 要求安全上下文：**HTTPS 或 localhost**。iOS 浏览器不支持 WebUSB（同 signal_tester 的结论）。

### 接线

1. USB-TTL 的 **TXD → 板子 RX、RXD → 板子 TX、GND → GND**（交叉接）
2. 板子右上角 3 针即调试串口（与客户远程配置用的是同一处，见 `lify-t/doc/for_client/instruction/NB-IoT_Configuration_Guide_Universal.docx`）
3. 串口 **固定 9600 8N1**（不留波特率选项）

### 不接硬件也能验判定：回放模式

页面最底下「回放模式」把已有日志粘进去（或导入 .txt），走同一套解析与判定。
也可以直接在地址后面加 `?demo=1` 看内置的健康样本。

## 密码与公开仓库（alpha 临时做法）

本仓库现在是 **public**，alpha 阶段直接把 AT 密码写在 [config.js](config.js) 里提交：

```js
window.DC_CONFIG = { atPassword: "******", profile: null };
```

- 为什么能接受：纯前端页面里的密码挡不住 F12，反正现场远程诊断时客户也能看到；提交只是省掉每次手输
- **代价**：公开过的密码就等于泄露过——git 历史里那份会一直在，别人 fork/clone 也带走了
- 所以：**改回 private 之前、或正式发客户之前，必须换一次设备 AT 密码**（改完只更新 config.js 并提交）
- 发客户时更稳的做法是换 Cloudflare Pages + Access（邮箱白名单），仓库保持 public 也无所谓

设备固件把 AT 命令锁在密码后面（防止有人插线就改 Device ID / AuthInfo / 服务器地址）。
密码属于**我们掌握的常量**，不出现在界面上：

```powershell
Copy-Item config.local.example.js config.local.js   # 已 gitignore，不会提交
# 编辑 config.local.js，填 atPassword
```

- `config.js`（已提交）：只有空默认值，`atPassword: ""`
- `config.local.js`（不提交）：真实密码，页面加载时覆盖默认值
- 留空也能跑：拿到的是设备上电自动打印的那一段（身份、配置、角度、对比角、重启原因、CSQ）
- 拿不到的是"要问设备才说"的项：电池电压、IMEI/ICCID、采集/上报间隔、角度阈值、安装方式、CFUN/NBAND

**没解锁时这些项一律标「未检查」，页面顶部会挂一条提示**——不会把"没读到"算成设备异常，
也不会静默显示成通过。这是硬规则（见 AGENTS.md）。

> 安全说明：纯前端页面里的密码挡不住会按 F12 的人，这里的目标只是不把密码摆在界面上、不写进日志。

## 诊断项

| 分组 | 检查项 | 判据 |
|---|---|---|
| 系统 | 设备识别、固件版本 | 能否识别变体 / 是否读到版本号 |
| 设备标识 | Device ID、AuthInfo、Product ID（NB）；DevEUI（LoRa） | 缺失或仍为出厂默认（1234567890 / 0000 / 全 0）判失败 |
| 参数配置 | 服务器、APN、COPS、频段、采集/上报间隔、角度阈值、安装方式 | 出厂默认 `0.0.0.0,0` 判失败；间隔必须整除；给了期望值就逐项比对 |
| 电源 | 电池电压 | < 3300 mV 失败，3300–3449 mV 提示 |
| 传感器 | 当前角度、内部对比角、两者偏差 | 角度同时接近 ±180 判 IMU 无效值；偏差超过阈值提示（否则装完就报警） |
| 时间/重启 | RTC、重启原因 | 年份 < 2024 判提示；重启原因只作证据 |
| 网络（NB） | CSQ、CFUN、IMEI、ICCID | `99,99` 提示；CFUN:0 失败 |
| 网络（LoRa） | 入网状态、RSSI | 未入网提示 |
| 日志 | AT 解锁、ERROR 行 | 密码错误提示；出现 ERROR 行失败 |

阈值集中在 `core.js` 的 `DEFAULT_THRESHOLDS`，改之前先看 `docs/protocol-notes.md`。

解锁状态会影响判定：**没有确认解锁成功时**（没有 `Correct Password`），需要查询才拿得到的
项（电池、间隔、阈值、安装方式、频段、CSQ、ICCID）标成 `skip / 未检查`，不参与 PASS/WARN/FAIL 汇总。

## 安全边界

- **只发查询命令**：`isAllowedCommand()` 拒绝任何 `AT+X=值` 的写入；`AT+FDR / AT+DISAT / AT+SIMLOCK / AT+CICICLE / AT+CICANGLE` 等直接黑名单。剧本在 `buildPlanScript()` 里是常量，客户界面没有命令输入框。
- **ATZ 固定执行**：诊断开始会重启设备一次（约 3 秒），用来拿完整启动块；界面上没有开关。
- **不联网**：没有远程脚本、没有请求；判定在本地算。
- **不脱敏**：Device ID / AuthInfo / IMEI / ICCID 全量显示——这套工具就是要让人把 log 直接复制发回来，藏起来没有意义。

## 目录

```
lifyt_device_diag/
├─ index.html                单页 UI + CH340/Web Serial 连接层
├─ core.js                   协议事实、剧本、解析、判定（无 DOM，node 可测）
├─ config.js                 AT 密码 + 可选期望值（alpha 阶段直接提交）
├─ docs/protocol-notes.md    设备控制台协议事实与来源、待真机确认项
├─ tests/replay.test.mjs     解析/判定/白名单断言（合成日志，无真实凭证）
├─ tests/page.test.mjs       页面与三语标签、DOM、无外链的一致性检查
├─ tests/fixtures/*.txt      合成日志夹具
└─ serve.cmd                 本地起静态服务
```

## 测试

```powershell
node tests/replay.test.mjs
node tests/page.test.mjs
```

（本仓库不使用 `node --test` 的批量模式：它要 spawn 子进程，在一些受限沙箱里会被拦；
直接执行测试文件即可，node 会在同进程里跑。）

## 关系

- 连接层移植自 `signal_tester/3-webusb/index.html` 的 CH340 驱动（详见 POSITIONING.md 的差异说明）
- 判定字段与口径对齐 `tree-sensor-manufacture-qc` 的 `check_logs.py`，但这里是"现场诊断"而不是"产线 QC"
