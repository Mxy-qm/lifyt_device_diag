// 默认配置（可提交，不含密钥）。
// 真实 AT 密码放在 config.local.js（已 gitignore），页面会先读这个、再读本地覆盖。
// 安全说明：纯前端页面里的密码挡不住任何会按 F12 的人，这里只是不把它摆在界面上、不进日志。
window.DC_CONFIG = {
  // 设备 AT 控制台密码；空字符串 = 只做免解锁的检查
  atPassword: "",
  // 可选：批次期望值，等价于界面上那个 JSON 框（对象或 JSON 字符串）
  profile: null
};
