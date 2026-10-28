import { app, BrowserWindow, globalShortcut, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Aligner, tokenize } from "../core/aligner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(app.getPath("userData"), "config.json");
const defaults = {
  opacity: 0.55, fontSize: 34, color: "#ffffff", lines: 4, width: 900,
  protectCapture: false, wsUrl: "ws://127.0.0.1:8791", lastScript: "",
};
const cfg = { ...defaults, ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}) };
const save = () => writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

let win, aligner, chunks = [], clickThrough = false;

function loadScript(text) {
  aligner = new Aligner(text);
  chunks = [];
  let n = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const k = tokenize(raw).length;
    if (k) { chunks.push({ t: raw, a: n, b: n + k, end: /[.!?…]["')]*$/.test(raw) }); n += k; }
  }
  push();
}

function push() {
  win?.webContents.send("state", { chunks, pos: aligner?.pos ?? 0, state: aligner?.state ?? "following", cfg });
}

function jumpSentence(dir) {
  if (!aligner) return;
  const ends = chunks.filter((c) => c.end).map((c) => c.b);
  const starts = [0, ...ends];
  aligner.jumpTo(dir > 0 ? (starts.find((s) => s > aligner.pos) ?? aligner.pos)
                         : ([...starts].reverse().find((s) => s < aligner.pos - 1) ?? 0));
  push();
}

async function openScript() {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: "Roteiro", extensions: ["md", "txt"] }] });
  if (r.canceled) return;
  cfg.lastScript = r.filePaths[0]; save();
  loadScript(readFileSync(cfg.lastScript, "utf8"));
}

function connectStt() {
  const ws = new WebSocket(cfg.wsUrl);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.final && aligner) { aligner.feed(m.text); push(); }
  };
  ws.onclose = () => setTimeout(connectStt, 1500); // sidecar pode subir depois
  ws.onerror = () => {};
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send("click-through", on);
}

const bump = (k, d, lo, hi) => { cfg[k] = Math.min(hi, Math.max(lo, +(cfg[k] + d).toFixed(2))); save(); push(); };

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: cfg.width, height: 260, transparent: true, frame: false, alwaysOnTop: true,
    hasShadow: false, skipTaskbar: true,
    webPreferences: { preload: join(here, "preload.cjs") },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setContentProtection(cfg.protectCapture);
  win.loadFile(join(here, "index.html"));
  win.webContents.on("did-finish-load", () => {
    loadScript(cfg.lastScript && existsSync(cfg.lastScript) ? readFileSync(cfg.lastScript, "utf8") : "Abra um roteiro com Ctrl+Alt+O.");
  });
  ipcMain.on("moved", () => {});

  const keys = {
    "Ctrl+Alt+O": openScript,
    "Ctrl+Alt+T": () => setClickThrough(!clickThrough),
    "Ctrl+Alt+H": () => (win.isVisible() ? win.hide() : win.show()),
    "Ctrl+Alt+Right": () => jumpSentence(1),
    "Ctrl+Alt+Left": () => jumpSentence(-1),
    "Ctrl+Alt+Up": () => bump("fontSize", 2, 14, 96),
    "Ctrl+Alt+Down": () => bump("fontSize", -2, 14, 96),
    "Ctrl+Alt+]": () => bump("opacity", 0.05, 0, 1),
    "Ctrl+Alt+[": () => bump("opacity", -0.05, 0, 1),
    "Ctrl+Alt+P": () => { cfg.protectCapture = !cfg.protectCapture; win.setContentProtection(cfg.protectCapture); save(); },
    "Ctrl+Alt+R": () => { aligner?.jumpTo(0); push(); },
  };
  for (const [k, fn] of Object.entries(keys)) globalShortcut.register(k, fn);
  startSidecar();
  connectStt();
});

// shortcut: caminho fixo da versão pessoal (venv fica fora do .exe); no SaaS, empacotar o motor.
const sttDir = process.env.TELEPROMPTER_STT ?? "E:\\Projetos\\teleprompter\\stt";
let sidecar;
function startSidecar() {
  const py = join(sttDir, ".venv", "Scripts", "python.exe");
  if (!existsSync(py)) return;
  sidecar = spawn(py, [join(sttDir, "server.py")], { windowsHide: true, stdio: "ignore" });
  sidecar.on("exit", () => (sidecar = null));
}

app.on("will-quit", () => sidecar?.kill());
app.on("window-all-closed", () => app.quit());
