// The one thing the page may ask of the desktop app: bring its window forward on a wake.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("onyxDesktop", {
  show: () => ipcRenderer.send("onyx:show"),
});
