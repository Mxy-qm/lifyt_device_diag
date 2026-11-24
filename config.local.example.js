// 复制成 config.local.js 再填（config.local.js 已 gitignore，不会被提交）。
// 页面会先加载 config.js，再加载本文件做覆盖。
Object.assign(window.DC_CONFIG, {
  atPassword: "填设备当前的 AT 密码",
  // profile: { server: "1.2.3.4,5683", apn: "cmhk", cops: "45412", nband: "8" }
});
