import { app, BrowserWindow, globalShortcut, dialog, ipcMain, shell } from "electron";
import { readFileSync, writeFileSync, existsSync, createWriteStream, unlinkSync, statSync, renameSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Aligner, tokenize } from "../core/aligner.ts";
import { cleanScript } from "../core/text.ts";

const REPO = "leoplanello/teleprompter";
const here = dirname(fileURLToPath(import.meta.url));
const data = app.getPath("userData");
const cfgPath = join(data, "config.json");
const scriptPath = join(data, "script.txt");
const defaults = {
  opacity: 0.55, fontSize: 34, color: "#ffffff", fontFamily: "Segoe UI", lines: 4, width: 900,
  protectCapture: false, showTaskbar: true, showHeard: true, scriptMode: true, device: null, langs: ["pt", "en"],
  // destaque do que está sendo lido
  highlightMode: "palavra", highlightColor: "#ffd54a", highlightOpacity: 0.85, highlightTextColor: "#111111",
  pastOpacity: 0.35, futureOpacity: 0.85, lead: 2, scrollSmooth: 160, anchor: 0.3,
  diagLog: true,
  wsUrl: "ws://127.0.0.1:8791", lastScript: "",
};
const cfg = { ...defaults, ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}) };
const save = () => writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const version = process.env.TP_FAKE_VERSION ?? app.getVersion(); // TP_FAKE_VERSION só serve para testar a atualização

// com a CPU cheia o Chromium rebaixa janelas "em segundo plano"; o teleprompter nunca pode ser rebaixado
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let win, settingsWin, aligner, scriptText = "", chunks = [], clickThrough = false, sttWs, quitting = false;
const stt = { connected: false, level: 0, heard: "", device: "", langs: [] };
// janela fechada/destruída (ao sair, ou ao fechar as configurações) não pode derrubar o app
const to = (w, ch, payload) => { if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(ch, payload); };
const send = (ch, payload) => { to(win, ch, payload); to(settingsWin, ch, payload); };

// registro para diagnóstico: o que foi ouvido e onde o app achou que você estava
const logPath = join(data, "sessao.log");
let logStream = null;
function diag(line) {
  if (!cfg.diagLog) return;
  if (!logStream) {
    try { if (existsSync(logPath) && statSync(logPath).size > 2_000_000) renameSync(logPath, logPath + ".old"); } catch {}
    logStream = createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n--- ${new Date().toISOString()} v${version}\n`);
  }
  logStream.write(`${Date.now() % 1e7} ${line}\n`);
}

// ---------- roteiro ----------
// palavras com acento, como o modelo de voz as conhece (o alinhador normaliza depois)
const grammarWords = (text) => [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w && !/^\d+$/.test(w)))];
function sendGrammar() {
  if (sttWs?.readyState === 1) sttWs.send(JSON.stringify({ cmd: "grammar", words: cfg.scriptMode ? grammarWords(cleanScript(scriptText)) : [] }));
}

function loadScript(text, persist = true) {
  scriptText = text;
  if (persist) writeFileSync(scriptPath, text);
  const shown = cleanScript(text); // símbolos e marcação não são lidos nem mostrados
  aligner = new Aligner(shown);
  chunks = [];
  let n = 0;
  for (const raw of shown.split(/\s+/).filter(Boolean)) {
    const k = tokenize(raw).length;
    if (k) { chunks.push({ t: raw, a: n, b: n + k, end: /[.!?…]["')]*$/.test(raw) }); n += k; }
  }
  to(win, "script", chunks);
  pushPos(true);
  sendGrammar();
}

function initialScript() {
  if (existsSync(scriptPath)) return readFileSync(scriptPath, "utf8");
  if (cfg.lastScript && existsSync(cfg.lastScript)) return readFileSync(cfg.lastScript, "utf8");
  return "Abra a configuração (engrenagem) e cole ou digite seu roteiro.";
}

// só posição e estado trafegam a cada palavra; o roteiro inteiro só quando muda
let lastPos = -1, lastState = "";
function pushPos(force = false) {
  if (!aligner || (!force && aligner.pos === lastPos && aligner.state === lastState)) return;
  lastPos = aligner.pos; lastState = aligner.state;
  to(win, "pos", { pos: lastPos, state: lastState });
}
const pushCfg = () => to(win, "cfg", cfg);

let lastSttPush = 0;
function pushStt(force = false) {
  const now = Date.now();
  if (!force && now - lastSttPush < 80) return;
  lastSttPush = now;
  send("stt", stt);
}

function jumpSentence(dir) {
  if (!aligner) return;
  const starts = [0, ...chunks.filter((c) => c.end).map((c) => c.b)];
  aligner.jumpTo(dir > 0 ? (starts.find((s) => s > aligner.pos) ?? aligner.pos)
                         : ([...starts].reverse().find((s) => s < aligner.pos - 1) ?? 0));
  pushPos();
}

async function pickScript(parent) {
  const r = await dialog.showOpenDialog(parent, { filters: [{ name: "Roteiro", extensions: ["md", "txt"] }] });
  return r.canceled ? null : readFileSync(r.filePaths[0], "utf8");
}

// ---------- motor de voz ----------
function connectStt() {
  const ws = (sttWs = new WebSocket(cfg.wsUrl));
  ws.onopen = sendGrammar;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "level") stt.level = m.v;
    else if (m.type === "status") { stt.connected = true; stt.device = m.device; stt.langs = m.langs; }
    else if ((m.type === "partial" || m.type === "final") && aligner) {
      if (m.text) stt.heard = m.text;
      aligner.feedStream(m.lang, m.text, m.type === "final");
      if (m.text || m.type === "final") diag(`${m.lang} ${m.type[0]} "${m.text}" -> pos=${aligner.pos} ${aligner.state}`);
      pushPos();
    }
    pushStt(m.type !== "level");
  };
  ws.onclose = () => {
    if (quitting) return;
    stt.connected = false; pushStt(true); setTimeout(connectStt, 1000);
  };
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

// ---------- atualização ----------
const upd = { phase: "idle", current: version, latest: "", pct: 0, msg: "" };
let relAsset = null, relSha = null;
const setUpd = (p) => { Object.assign(upd, p); send("update", upd); };
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

async function checkUpdate(silent = false) {
  if (upd.phase === "downloading") return;
  if (!silent) setUpd({ phase: "checking", msg: "" });
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "teleprompter", Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
    const j = await r.json();
    const latest = j.tag_name.replace(/^v/, "");
    relAsset = j.assets.find((a) => a.name === "Teleprompter.exe");
    relSha = j.assets.find((a) => a.name === "Teleprompter.exe.sha256");
    if (newer(latest, version) && relAsset) setUpd({ phase: "available", latest, msg: "" });
    else if (!silent) setUpd({ phase: "uptodate", latest, msg: "" });
  } catch (e) {
    if (!silent) setUpd({ phase: "error", msg: `Não consegui verificar: ${e.message}` });
  }
}

async function installUpdate() {
  const target = process.env.PORTABLE_EXECUTABLE_FILE; // definido pelo executável portátil
  if (!target) return setUpd({ phase: "error", msg: "A atualização automática só funciona no Teleprompter.exe, não no modo de desenvolvimento." });
  if (upd.phase !== "available" || !relAsset) return;
  const tmp = target + ".new";
  try {
    setUpd({ phase: "downloading", pct: 0, msg: "" });
    const res = await fetch(relAsset.browser_download_url, { headers: { "User-Agent": "teleprompter" } });
    if (!res.ok) throw new Error(`download falhou (${res.status})`);
    const total = +res.headers.get("content-length") || relAsset.size;
    const out = createWriteStream(tmp), hash = createHash("sha256");
    let got = 0, lastPct = -1;
    for await (const c of res.body) {
      hash.update(c); got += c.length;
      if (!out.write(c)) await once(out, "drain");
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) { lastPct = pct; setUpd({ pct }); }
    }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
    const want = (relAsset.digest?.replace("sha256:", "") ??
      (relSha && (await (await fetch(relSha.browser_download_url)).text()).trim().split(/\s+/)[0]) ?? "").toLowerCase();
    if (!want || hash.digest("hex") !== want) throw new Error("o arquivo baixado não confere com o hash publicado; atualização cancelada");
    // espera este processo soltar o .exe, troca e reabre
    const cmd = join(tmpdir(), "teleprompter-update.cmd");
    writeFileSync(cmd, [
      "@echo off",
      "for /l %%i in (1,1,40) do (",
      `  move /y "${tmp}" "${target}" >nul 2>&1 && goto ok`,
      "  ping 127.0.0.1 -n 2 >nul",
      ")",
      "exit /b 1",
      ":ok",
      `start "" "${target}"`,
      'del "%~f0"',
    ].join("\r\n"));
    spawn("cmd.exe", ["/c", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setUpd({ phase: "restarting", msg: "Reiniciando com a nova versão…" });
    setTimeout(() => app.quit(), 300);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    setUpd({ phase: "error", msg: e.message });
  }
}

// ---------- janela ----------
const winHeight = () => Math.round(cfg.lines * cfg.fontSize * 1.35) + 52;

function applyCfg(key) {
  if (["fontSize", "lines", "width"].includes(key)) win.setSize(cfg.width, winHeight());
  if (key === "protectCapture") win.setContentProtection(cfg.protectCapture);
  if (key === "showTaskbar") win.setSkipTaskbar(!cfg.showTaskbar);
  if (key === "device" || key === "langs") restartSidecar();
  if (key === "scriptMode") sendGrammar();
  save(); pushCfg();
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  to(win, "click-through", on);
}

function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 620, height: 880, title: "Configurações do Teleprompter", autoHideMenuBar: true,
    webPreferences: { preload: join(here, "preload.cjs"), backgroundThrottling: false },
  });
  settingsWin.loadFile(join(here, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

const bump = (k, d, lo, hi) => { cfg[k] = Math.min(hi, Math.max(lo, +(cfg[k] + d).toFixed(2))); applyCfg(k); };

ipcMain.handle("get", () => ({ cfg, script: scriptText, stt, upd, version }));
ipcMain.handle("devices", () => listDevices());
ipcMain.handle("set", (_, k, v) => { cfg[k] = v; applyCfg(k); });
ipcMain.handle("script:set", (_, text) => loadScript(text));
ipcMain.handle("script:open", async () => pickScript(settingsWin));
ipcMain.handle("script:save", async (_, text) => {
  const r = await dialog.showSaveDialog(settingsWin, { defaultPath: "roteiro.txt", filters: [{ name: "Texto", extensions: ["txt", "md"] }] });
  if (!r.canceled) writeFileSync(r.filePath, text);
});
ipcMain.handle("reset-pos", () => { aligner?.jumpTo(0); pushPos(true); });
ipcMain.handle("update:check", () => checkUpdate());
ipcMain.handle("update:install", () => installUpdate());
ipcMain.on("open-settings", openSettings);
ipcMain.on("quit", () => app.quit());
ipcMain.handle("open-log-folder", () => shell.showItemInFolder(existsSync(logPath) ? logPath : cfgPath));

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: cfg.width, height: winHeight(), transparent: true, frame: false, alwaysOnTop: true,
    hasShadow: false, skipTaskbar: !cfg.showTaskbar, title: "Teleprompter",
    webPreferences: { preload: join(here, "preload.cjs"), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setContentProtection(cfg.protectCapture);
  win.loadFile(join(here, "index.html"));
  win.webContents.on("did-finish-load", () => { pushCfg(); loadScript(initialScript(), false); pushStt(true); send("update", upd); });

  const keys = {
    "Ctrl+Alt+S": openSettings,
    "Ctrl+Alt+O": async () => { const t = await pickScript(win); if (t) loadScript(t); },
    "Ctrl+Alt+T": () => setClickThrough(!clickThrough),
    "Ctrl+Alt+H": () => (win.isVisible() ? win.hide() : win.show()),
    "Ctrl+Alt+Q": () => app.quit(),
    "Ctrl+Alt+Right": () => jumpSentence(1),
    "Ctrl+Alt+Left": () => jumpSentence(-1),
    "Ctrl+Alt+Up": () => bump("fontSize", 2, 14, 96),
    "Ctrl+Alt+Down": () => bump("fontSize", -2, 14, 96),
    "Ctrl+Alt+]": () => bump("opacity", 0.05, 0, 1),
    "Ctrl+Alt+[": () => bump("opacity", -0.05, 0, 1),
    "Ctrl+Alt+P": () => { cfg.protectCapture = !cfg.protectCapture; applyCfg("protectCapture"); },
    "Ctrl+Alt+R": () => { aligner?.jumpTo(0); pushPos(true); },
  };
  for (const [k, fn] of Object.entries(keys)) globalShortcut.register(k, fn);
  startSidecar();
  connectStt();
  setTimeout(() => checkUpdate(true), 4000);
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { sidecar?.kill(); logStream?.end(); });
app.on("window-all-closed", () => app.quit());
