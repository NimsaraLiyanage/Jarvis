// Starts the Python core. A core left over from an earlier run can keep hold of the
// port and silently swallow requests, so anything already listening there is stopped first.
const { execSync, spawn } = require("child_process");
const path = require("path");

const PORT = 8765;
const root = path.join(__dirname, "..");

function pidsListeningOn(port) {
  try {
    const lines = execSync("netstat -ano -p tcp", { encoding: "utf8" }).split(/\r?\n/);
    const pids = lines
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[0] === "TCP" && cols[1].endsWith(`:${port}`) && cols[3] === "LISTENING")
      .map((cols) => cols[4]);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

for (const pid of pidsListeningOn(PORT)) {
  console.log(`Stopping an old core still holding port ${PORT} (pid ${pid})`);
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

const python = path.join(root, "core", ".venv", "Scripts", "python.exe");
const args = ["-m", "uvicorn", "jarvis.main:app", "--app-dir", "core", "--host", "127.0.0.1", "--port", String(PORT), "--reload", "--reload-dir", "core/jarvis"];
const child = spawn(python, args, { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

// Take the whole process tree down with us; the reloader's worker otherwise survives.
const stop = () => {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    // Already gone.
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
