const { contextBridge, ipcRenderer } = require("electron");
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld("tp", {
  onState: (f) => ipcRenderer.on("state", (_, s) => f(s)),
  onStt: (f) => ipcRenderer.on("stt", (_, s) => f(s)),
  onClickThrough: (f) => ipcRenderer.on("click-through", (_, on) => f(on)),
  openSettings: () => ipcRenderer.send("open-settings"),
  get: inv("get"), devices: inv("devices"), set: inv("set"),
  setScript: inv("script:set"), openScript: inv("script:open"), saveScript: inv("script:save"),
  resetPos: inv("reset-pos"),
});
