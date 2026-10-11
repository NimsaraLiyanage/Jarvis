// Starts Electron with ELECTRON_RUN_AS_NODE cleared. Terminals opened from
// VS Code can inherit that variable, which makes Electron run as plain Node.
const { spawn } = require("child_process");
const path = require("path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(require("electron"), [path.join(__dirname, "..")], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
