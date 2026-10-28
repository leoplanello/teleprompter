const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("tp", {
  onState: (f) => ipcRenderer.on("state", (_, s) => f(s)),
  onClickThrough: (f) => ipcRenderer.on("click-through", (_, on) => f(on)),
});
