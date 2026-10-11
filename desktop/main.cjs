const { app, BrowserWindow, shell } = require("electron");

const UI_URL = process.env.JARVIS_UI_URL || "http://localhost:5173";

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: "#05080f",
    autoHideMenuBar: true,
    title: "JARVIS",
  });

  // Links in replies open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(UI_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
