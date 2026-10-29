const { contextBridge, ipcRenderer } = require("electron");
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
const on = (c) => (f) => ipcRenderer.on(c, (_, p) => f(p));
contextBridge.exposeInMainWorld("tp", {
  onScript: on("script"), onPos: on("pos"), onCfg: on("cfg"), onStt: on("stt"), onUpdate: on("update"),
  onClickThrough: on("click-through"),
  openSettings: () => ipcRenderer.send("open-settings"),
  quit: () => ipcRenderer.send("quit"),
  get: inv("get"), devices: inv("devices"), set: inv("set"),
  setScript: inv("script:set"), openScript: inv("script:open"), saveScript: inv("script:save"),
  resetPos: inv("reset-pos"), checkUpdate: inv("update:check"), installUpdate: inv("update:install"), openLog: inv("open-log-folder"),
});
