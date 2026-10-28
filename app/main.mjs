import { app, BrowserWindow, globalShortcut, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Aligner, tokenize } from "../core/aligner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const data = app.getPath("userData");
const cfgPath = join(data, "config.json");
const scriptPath = join(data, "script.txt");
const defaults = {
  opacity: 0.55, fontSize: 34, color: "#ffffff", fontFamily: "Segoe UI", lines: 4, width: 900,
  protectCapture: false, showTaskbar: true, showHeard: true, device: null, langs: ["pt", "en"],
  wsUrl: "ws://127.0.0.1:8791", lastScript: "",
};
const cfg = { ...defaults, ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}) };
const save = () => writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

let win, settingsWin, aligner, scriptText = "", chunks = [], clickThrough = false;
const stt = { connected: false, level: 0, heard: "", device: "", langs: [] };

// ---------- roteiro ----------
function loadScript(text, persist = true) {
  scriptText = text;
  if (persist) writeFileSync(scriptPath, text);
  aligner = new Aligner(text);
  chunks = [];
  let n = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const k = tokenize(raw).length;
    if (k) { chunks.push({ t: raw, a: n, b: n + k, end: /[.!?…]["')]*$/.test(raw) }); n += k; }
  }
  push();
}

function initialScript() {
  if (existsSync(scriptPath)) return readFileSync(scriptPath, "utf8");
  if (cfg.lastScript && existsSync(cfg.lastScript)) return readFileSync(cfg.lastScript, "utf8");
  return "Abra a configuração (engrenagem) e cole ou digite seu roteiro.";
}

function push() {
  win?.webContents.send("state", { chunks, pos: aligner?.pos ?? 0, state: aligner?.state ?? "following", cfg });
}

let lastSttPush = 0;
function pushStt(force = false) {
  const now = Date.now();
  if (!force && now - lastSttPush < 80) return;
  lastSttPush = now;
  win?.webContents.send("stt", stt);
  settingsWin?.webContents.send("stt", stt);
}

function jumpSentence(dir) {
  if (!aligner) return;
  const starts = [0, ...chunks.filter((c) => c.end).map((c) => c.b)];
  aligner.jumpTo(dir > 0 ? (starts.find((s) => s > aligner.pos) ?? aligner.pos)
                         : ([...starts].reverse().find((s) => s < aligner.pos - 1) ?? 0));
  push();
}

async function pickScript(parent) {
  const r = await dialog.showOpenDialog(parent, { filters: [{ name: "Roteiro", extensions: ["md", "txt"] }] });
  return r.canceled ? null : readFileSync(r.filePaths[0], "utf8");
}

// ---------- motor de voz ----------
function connectStt() {
  const ws = new WebSocket(cfg.wsUrl);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "level") stt.level = m.v;
    else if (m.type === "status") { stt.connected = true; stt.device = m.device; stt.langs = m.langs; }
    else if ((m.type === "partial" || m.type === "final") && aligner) {
      stt.heard = m.text;
      aligner.feedStream(m.lang, m.text, m.type === "final");
      push();
    }
    pushStt(m.type !== "level");
  };
  ws.onclose = () => { stt.connected = false; pushStt(true); setTimeout(connectStt, 1000); };
  ws.onerror = () => {};
}

// shortcut: caminho fixo da versão pessoal (venv fica fora do .exe); no SaaS, empacotar o motor.
const sttDir = process.env.TELEPROMPTER_STT ?? "E:\\Projetos\\teleprompter\\stt";
const py = () => join(sttDir, ".venv", "Scripts", "python.exe");
let sidecar;

function startSidecar() {
  if (!existsSync(py())) return;
  const args = [join(sttDir, "server.py"), "--langs", cfg.langs.join(",")];
  if (cfg.device !== null && cfg.device !== "") args.push("--device", String(cfg.device));
  sidecar = spawn(py(), args, { windowsHide: true, stdio: "ignore" });
  sidecar.on("exit", () => (sidecar = null));
}

function restartSidecar() {
  stt.connected = false; pushStt(true);
  if (!sidecar) return startSidecar();
  sidecar.once("exit", startSidecar);
  sidecar.kill();
}

function listDevices() {
  try { return JSON.parse(execFileSync(py(), [join(sttDir, "server.py"), "--list-devices"], { encoding: "utf8" })); }
  catch { return []; }
}

// ---------- janela ----------
const winHeight = () => Math.round(cfg.lines * cfg.fontSize * 1.35) + 52;

function applyCfg(key) {
  if (["fontSize", "lines", "width"].includes(key)) win.setSize(cfg.width, winHeight());
  if (key === "protectCapture") win.setContentProtection(cfg.protectCapture);
  if (key === "showTaskbar") win.setSkipTaskbar(!cfg.showTaskbar);
  if (key === "device" || key === "langs") restartSidecar();
  save(); push();
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send("click-through", on);
}

function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 620, height: 820, title: "Configurações do Teleprompter", autoHideMenuBar: true,
    webPreferences: { preload: join(here, "preload.cjs") },
  });
  settingsWin.loadFile(join(here, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

const bump = (k, d, lo, hi) => { cfg[k] = Math.min(hi, Math.max(lo, +(cfg[k] + d).toFixed(2))); applyCfg(k); };

ipcMain.handle("get", () => ({ cfg, script: scriptText, stt, pos: aligner?.pos ?? 0 }));
ipcMain.handle("devices", () => listDevices());
ipcMain.handle("set", (_, k, v) => { cfg[k] = v; applyCfg(k); });
ipcMain.handle("script:set", (_, text) => loadScript(text));
ipcMain.handle("script:open", async () => pickScript(settingsWin));
ipcMain.handle("script:save", async (_, text) => {
  const r = await dialog.showSaveDialog(settingsWin, { defaultPath: "roteiro.txt", filters: [{ name: "Texto", extensions: ["txt", "md"] }] });
  if (!r.canceled) writeFileSync(r.filePath, text);
});
ipcMain.handle("reset-pos", () => { aligner?.jumpTo(0); push(); });
ipcMain.on("open-settings", openSettings);

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: cfg.width, height: winHeight(), transparent: true, frame: false, alwaysOnTop: true,
    hasShadow: false, skipTaskbar: !cfg.showTaskbar, title: "Teleprompter",
    webPreferences: { preload: join(here, "preload.cjs") },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setContentProtection(cfg.protectCapture);
  win.loadFile(join(here, "index.html"));
  win.webContents.on("did-finish-load", () => { loadScript(initialScript(), false); pushStt(true); });

  const keys = {
    "Ctrl+Alt+S": openSettings,
    "Ctrl+Alt+O": async () => { const t = await pickScript(win); if (t) loadScript(t); },
    "Ctrl+Alt+T": () => setClickThrough(!clickThrough),
    "Ctrl+Alt+H": () => (win.isVisible() ? win.hide() : win.show()),
    "Ctrl+Alt+Right": () => jumpSentence(1),
    "Ctrl+Alt+Left": () => jumpSentence(-1),
    "Ctrl+Alt+Up": () => bump("fontSize", 2, 14, 96),
    "Ctrl+Alt+Down": () => bump("fontSize", -2, 14, 96),
    "Ctrl+Alt+]": () => bump("opacity", 0.05, 0, 1),
    "Ctrl+Alt+[": () => bump("opacity", -0.05, 0, 1),
    "Ctrl+Alt+P": () => { cfg.protectCapture = !cfg.protectCapture; applyCfg("protectCapture"); },
    "Ctrl+Alt+R": () => { aligner?.jumpTo(0); push(); },
  };
  for (const [k, fn] of Object.entries(keys)) globalShortcut.register(k, fn);
  startSidecar();
  connectStt();
});

app.on("will-quit", () => sidecar?.kill());
app.on("window-all-closed", () => app.quit());
