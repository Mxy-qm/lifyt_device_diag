# lifyt_device_diag · 设备体检（USB-TTL 直连）

USB-TTL 接到 LiFY-T 树传感器的串口，网页自动跑一套**固定体检剧本**，直接给出
PASS / WARN / FAIL、分组明细和可复制的报告。客户只需要插线、点一次按钮、看结论。

- 变体：TSE NB（BC95-GV / OneNET）与 TSE LoRaWAN（Pixel/TrackCentral 侧），**自动识别**
- 连接：CH340 用 WebUSB 直驱（手机 OTG / 台式机都能用）；Web Serial 作为桌面兜底
- 判定：以设备控制台的真实输出为准，不猜；给了批次期望值就逐项比对
- 形态：纯前端单页，不联网、不上传日志

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
3. 默认 **9600 8N1**；自动模式会先试 9600，没数据再试 115200

### 不接硬件也能验判定：回放模式

页面最底下「回放模式」把已有日志粘进去（或导入 .txt），走同一套解析与判定。
也可以直接在地址后面加 `?demo=1` 看内置的健康样本。

## 体检项

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

## 安全边界

- **只发查询命令**：`isAllowedCommand()` 拒绝任何 `AT+X=值` 的写入；`AT+FDR / AT+DISAT / AT+SIMLOCK / AT+CICICLE / AT+CICANGLE` 等直接黑名单。剧本在 `buildPlanScript()` 里是常量，客户界面没有命令输入框。
- **ATZ 是唯一"有动作"的命令**：只用于采集完整启动日志，高级面板里可以关掉。
- **不联网**：没有远程脚本、没有请求；判定在本地算。
- **脱敏**：Device ID / AuthInfo / IMEI / ICCID 默认只显示尾号，高级面板可开全量。

## 目录

```
lifyt_device_diag/
├─ index.html                单页 UI + CH340/Web Serial 连接层
├─ core.js                   协议事实、剧本、解析、判定（无 DOM，node 可测）
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
- 判定字段与口径对齐 `tree-sensor-manufacture-qc` 的 `check_logs.py`，但这里是"现场体检"而不是"产线 QC"
