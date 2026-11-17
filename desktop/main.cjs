// The desktop app. It lives in the tray: closing the window hides it, so the
// core keeps listening for "Hey Onyx" and the hotkey and can bring it back.
//
// --dev loads the Vite dev server (npm run desktop starts the core and Vite).
// Without it the app starts its own core, which serves the built UI from dist/
// (npm run app), so it can also start with Windows.
// --hidden starts in the tray, which is how it starts with Windows.
const { app, BrowserWindow, Menu, Tray, ipcMain, shell } = require("electron");
const { execSync, spawn } = require("child_process");
const path = require("path");

const DEV = process.argv.includes("--dev");
const START_HIDDEN = process.argv.includes("--hidden");
const ROOT = path.join(__dirname, "..");
const CORE_URL = "http://127.0.0.1:8765";
const UI_URL = process.env.JARVIS_UI_URL || (DEV ? "http://localhost:5173" : CORE_URL);
const CORE_START_TIMEOUT_MS = 30_000;

let win = null;
let tray = null;
let core = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: "#05080f",
    autoHideMenuBar: true,
    title: "ONYX",
    icon: path.join(__dirname, "icon-256.png"),
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // Hidden in the tray it must still react to a wake at once and play the reply.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Links in replies open in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  win.loadURL(UI_URL);
}

function loginArgs() {
  // In this unpackaged app Windows starts electron.exe, so it needs the app folder too.
  return app.isPackaged ? ["--hidden"] : [ROOT, "--hidden"];
}

function createTray() {
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("Onyx — say “Hey Onyx” or press Ctrl+Alt+O");
  const menu = () =>
    Menu.buildFromTemplate([
      { label: "Open Onyx", click: showWindow },
      {
        label: "Start with Windows",
        type: "checkbox",
        // Starting with Windows needs the app to run its own core, so not in --dev.
        enabled: !DEV,
        checked: app.getLoginItemSettings({ args: loginArgs() }).openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: loginArgs() }),
      },
      { type: "separator" },
      { label: "Quit Onyx", click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on("click", showWindow);
  // Rebuilt on open so the checkbox matches what Windows has.
  tray.on("right-click", () => tray.setContextMenu(menu()));
}

async function coreIsUp() {
  try {
    return (await fetch(`${CORE_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function startCore() {
  // start-core.cjs stops any old core first; ELECTRON_RUN_AS_NODE makes Electron act as Node for it.
  core = spawn(process.execPath, [path.join(__dirname, "start-core.cjs")], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", JARVIS_SERVE_UI: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  const deadline = Date.now() + CORE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await coreIsUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error("The Onyx core did not start in time; the window will keep retrying.");
}

function stopCore() {
  if (!core) return;
  try {
    execSync(`taskkill /PID ${core.pid} /T /F`, { stdio: "ignore" });
  } catch {
    // Already gone.
  }
  core = null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  ipcMain.on("onyx:show", showWindow);

  app.whenReady().then(async () => {
    createTray();
    if (!DEV) await startCore();
    createWindow();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopCore();
  });

  // The tray keeps the app alive with no window open.
  app.on("window-all-closed", () => {});
}
