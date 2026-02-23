const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

// ================== SETTINGS ==================
const TELEGRAM_TOKEN = "8436996818:AAEC6V62w3Eijtm9xI5BZv6JeSiThnki2G4";
const ALLOWED_USER_ID = 8397356794; // din Telegram user id (fra tidligere)

const PROJECT_ROOT = "C:/Users/liame/ai-netlify-site";
const AGENT_DIR = __dirname;
const STATE_FILE = path.join(AGENT_DIR, "agent_state.json");

const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = "qwen2.5:3b"; // stabil CPU-modell
const MODEL_TIMEOUT_MS = 600_000; // 10 min
const MODEL_RETRIES = 2; // i tillegg til første forsøk

const WORKER_INTERVAL_MS = 20_000; // sjekk kø hver 20 sek

// Fil-sandbox: agenten får lov å jobbe med disse + /assets/*
const ALLOWED_TOP_FILES = new Set(["index.html", "style.css", "script.js", "package.json"]);
const ALLOWED_DIRS = ["assets", "netlify", "agent"]; // netlify hvis du vil ha redirects/functions senere
const MAX_ACTIONS_PER_STEP = 6;

// "store endringer" = krever godkjenning (så du ser det før det deployes)
const LARGE_FILE_THRESHOLD_CHARS = 4500;

// npm: grønne pakker installeres automatisk, alt annet spør
const NPM_GREEN_WHITELIST = new Set(["axios", "date-fns", "lodash"]);

// Eksterne CDN/ressurser i HTML => gul
const BLOCKED_PROTOCOLS = ["file:", "ftp:"];
// =================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ---------------- STATE ----------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      goal: "",
      queue: [],
      done: [],
      current: null,
      paused: false,
      pendingApproval: null,
      lastChatId: null,
      lastUpdate: "",
      log: [],
      snapshots: []
    };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function stamp() {
  return new Date().toLocaleString("no-NO");
}
function pushLog(state, line) {
  const entry = `${stamp()} — ${line}`;
  state.log = state.log || [];
  state.log.push(entry);
  // keep last 80 lines
  if (state.log.length > 80) state.log = state.log.slice(-80);
}
function short(s, n = 300) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function mdEscape(s) {
  return (s || "").replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ---------------- PATH SAFETY ----------------
function safeResolve(relPath) {
  if (!relPath || typeof relPath !== "string") return null;

  const cleaned = relPath.replace(/\\/g, "/").trim();

  // absolute paths not allowed
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) return null;

  // directory traversal
  if (cleaned.includes("..")) return null;

  // forbid weird protocols
  for (const p of BLOCKED_PROTOCOLS) {
    if (cleaned.toLowerCase().startsWith(p)) return null;
  }

  const abs = path.resolve(PROJECT_ROOT, cleaned);
  const rootAbs = path.resolve(PROJECT_ROOT);
  if (!abs.startsWith(rootAbs)) return null;
  return abs;
}

function isAllowedPath(relPath) {
  if (!relPath) return false;
  const p = relPath.replace(/\\/g, "/").trim();

  // allow top files
  if (ALLOWED_TOP_FILES.has(p)) return true;

  // allow assets/*
  for (const d of ALLOWED_DIRS) {
    if (p === d) return true;
    if (p.startsWith(d + "/")) return true;
  }

  return false;
}

function hasExternalUrlsInHtml(html) {
  const t = (html || "").toLowerCase();
  // external http(s) references
  return (
    t.includes('src="http') ||
    t.includes("src='http") ||
    t.includes('href="http') ||
    t.includes("href='http")
  );
}

// ---------------- COMMAND RUNNER ----------------
function run(cmd, cwd = PROJECT_ROOT) {
  return new Promise((resolve) => {
    exec(cmd, { cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.toString() || "", stderr: stderr?.toString() || "" });
    });
  });
}
async function gitHasChanges() {
  const r = await run("git status --porcelain");
  return r.ok && r.stdout.trim().length > 0;
}
async function gitCommitPush(message = "AI update") {
  const changes = await gitHasChanges();
  if (!changes) return { ok: true, note: "ℹ️ Ingen endringer å deploye." };

  const add = await run("git add .");
  if (!add.ok) return { ok: false, note: "Git add feilet.", detail: add.stderr };

  const commit = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
  if (!commit.ok) return { ok: false, note: "Git commit feilet.", detail: commit.stderr };

  const push = await run("git push");
  if (!push.ok) return { ok: false, note: "Git push feilet.", detail: push.stderr };

  return { ok: true, note: "🚀 Deployet til Netlify." };
}

// ---------------- SNAPSHOTS / ROLLBACK ----------------
function snapshotFiles() {
  const snap = {};
  const files = ["index.html", "style.css", "script.js", "package.json"];
  for (const f of files) {
    const abs = safeResolve(f);
    if (abs && fs.existsSync(abs)) snap[f] = fs.readFileSync(abs, "utf8");
    else snap[f] = null;
  }
  return snap;
}
function applySnapshot(snap) {
  for (const [f, content] of Object.entries(snap || {})) {
    const abs = safeResolve(f);
    if (!abs) continue;
    if (content === null) {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } else {
      fs.writeFileSync(abs, content, "utf8");
    }
  }
}

// ---------------- RISK ENGINE ----------------
function riskOfAction(a, projectBefore = null) {
  // red by default
  if (!a || typeof a !== "object") return { level: "red", reason: "Mangler action-objekt." };
  if (!a.type || typeof a.type !== "string") return { level: "red", reason: "Mangler type." };

  const allowedTypes = new Set([
    "create_file",
    "modify_file",
    "create_folder",
    "delete_file",
    "npm_install",
    "modify_package_json",
    "web_search_wikipedia"
  ]);
  if (!allowedTypes.has(a.type)) return { level: "red", reason: `Ukjent action-type: ${a.type}` };

  // wikipedia search always yellow
  if (a.type === "web_search_wikipedia") {
    if (!a.query || typeof a.query !== "string") return { level: "red", reason: "Wikipedia query mangler." };
    return { level: "yellow", reason: "Web-søk krever godkjenning." };
  }

  // npm rules
  if (a.type === "npm_install") {
    const pkg = (a.package || "").trim();
    if (!pkg) return { level: "red", reason: "npm package mangler." };
    if (pkg.includes(" ") || /[;&|]/.test(pkg)) return { level: "red", reason: "Ugyldig package-streng." };
    if (pkg.includes("..") || pkg.includes("/") || pkg.includes("\\") || pkg.startsWith("-"))
      return { level: "red", reason: "Mistenkelig package-streng." };

    if (NPM_GREEN_WHITELIST.has(pkg)) return { level: "green", reason: "Whitelist npm-pakke." };
    return { level: "yellow", reason: "Ny npm-pakke krever godkjenning." };
  }

  // all remaining types require path
  if (!a.path || typeof a.path !== "string") return { level: "red", reason: "Path mangler." };
  const abs = safeResolve(a.path);
  if (!abs) return { level: "red", reason: "Ugyldig/ikke tillatt path." };

  if (!isAllowedPath(a.path)) {
    return { level: "red", reason: "Utenfor sandbox (ikke tillatt fil/mappe)." };
  }

  // package.json modifications -> yellow
  if (a.type === "modify_package_json" || a.path === "package.json") {
    return { level: "yellow", reason: "Endring av package.json krever godkjenning." };
  }

  // delete is yellow (sletting er alltid “usikker”)
  if (a.type === "delete_file") return { level: "yellow", reason: "Sletting krever godkjenning." };

  // external URLs in html -> yellow
  if ((a.type === "create_file" || a.type === "modify_file") && a.path === "index.html") {
    if (hasExternalUrlsInHtml(a.content || "")) {
      return { level: "yellow", reason: "Eksterne lenker/CDN i HTML krever godkjenning." };
    }
  }

  // big changes -> yellow (du ønsket godkjenning på “store steg”)
  if ((a.type === "create_file" || a.type === "modify_file") && typeof a.content === "string") {
    const newLen = a.content.length;
    const oldLen = projectBefore?.[a.path]?.length || 0;
    const delta = Math.abs(newLen - oldLen);
    if (newLen > LARGE_FILE_THRESHOLD_CHARS || delta > LARGE_FILE_THRESHOLD_CHARS) {
      return { level: "yellow", reason: "Stor endring (mye innhold) krever godkjenning." };
    }
  }

  return { level: "green", reason: "Trygg endring i prosjektet." };
}

// ---------------- PLAN TEXT (Telegram friendly) ----------------
function prettyActionLine(a) {
  if (a.type === "npm_install") return `• Installere npm-pakke: ${a.package}`;
  if (a.type === "web_search_wikipedia") return `• Wikipedia-søk: "${a.query}"`;
  if (a.type === "create_folder") return `• Lage mappe: ${a.path}`;
  if (a.type === "delete_file") return `• Slette: ${a.path}`;
  if (a.type === "modify_package_json") return `• Endre: package.json`;
  if (a.type === "create_file") return `• Opprette/overskrive: ${a.path}`;
  if (a.type === "modify_file") return `• Oppdatere: ${a.path}`;
  return `• ${a.type} ${a.path || ""}`.trim();
}

function buildApprovalMessage(task, actions, reasons) {
  const lines = actions.map(prettyActionLine).join("\n");
  const why = reasons.map((r) => `• ${r}`).join("\n");

  return (
    `⚠️ Krever godkjenning\n\n` +
    `🧩 Oppgave:\n${task}\n\n` +
    `📋 Plan:\n${lines}\n\n` +
    `🔎 Hvorfor det spør:\n${why}\n\n` +
    `Svar:\n• JA = godkjenn\n• NEI = avbryt\n• /status = vis status`
  );
}

// ---------------- SAFE WEB (Wikipedia only) ----------------
async function wikiSummary(query) {
  const q = (query || "").trim();
  if (!q) return { ok: false, error: "Tomt søk." };

  const open = await axios.get("https://en.wikipedia.org/w/api.php", {
    params: { action: "opensearch", search: q, limit: 1, namespace: 0, format: "json" },
    timeout: 12_000
  });

  const bestTitle = Array.isArray(open.data) && open.data[1] && open.data[1][0] ? open.data[1][0] : null;
  if (!bestTitle) return { ok: false, error: "Fant ingen Wikipedia-treff." };

  const sum = await axios.get(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(bestTitle)}`,
    { timeout: 12_000 }
  );

  return {
    ok: true,
    title: bestTitle,
    url: sum.data?.content_urls?.desktop?.page || "",
    extract: (sum.data?.extract || "").slice(0, 1200)
  };
}

// ---------------- MODEL CALL (robust) ----------------
function extractJson(text) {
  // strict parse first
  try {
    return JSON.parse(text);
  } catch {}

  // attempt slice outermost object
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const chunk = text.slice(first, last + 1);
    try {
      return JSON.parse(chunk);
    } catch {}
  }

  return null;
}

function systemPrompt(state) {
  return `
Du er en kode-agent for et Netlify-prosjekt.
Du MÅ svare med KUN gyldig JSON. Ingen tekst før/etter. Ingen markdown.

Prosjektmål:
${state.goal || "(ikke satt ennå)"}

Du har en sandbox:
- Du kan kun endre disse filene i prosjektet: index.html, style.css, script.js, package.json
- Du kan lage/endre ting under assets/*
- Du må aldri foreslå paths utenfor prosjektet.

Returner format:
{
  "actions": [
    {
      "type": "create_file|modify_file|create_folder|delete_file|npm_install|modify_package_json|web_search_wikipedia",
      "path": "index.html|style.css|script.js|package.json|assets/..|mappe",
      "content": "FULLT FILINNHOLD (kun for create/modify)",
      "package": "npm-pakke (kun for npm_install)",
      "query": "Wikipedia-søk (kun for web_search_wikipedia)"
    }
  ],
  "note": "kort status"
}

VIKTIG:
- Maks ${MAX_ACTIONS_PER_STEP} actions per svar.
- Ikke finn på egne action-typer (som add_class).
- Lag en super profesjonell nettside: god typografi, spacing, layout, responsivitet, accessibility.
- Del store jobber i små, naturlige steg.
`;
}

async function callModelWithRetry(state, taskText, extraData = null) {
  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt(state) },
      { role: "user", content: taskText }
    ],
    stream: false
  };

  if (extraData) payload.messages.push({ role: "user", content: extraData });

  let lastErr = null;

  for (let attempt = 0; attempt <= MODEL_RETRIES; attempt++) {
    try {
      const res = await axios.post(`${OLLAMA_URL}/api/chat`, payload, { timeout: MODEL_TIMEOUT_MS });
      const content = res.data?.message?.content || "";
      return { ok: true, content };
    } catch (err) {
      lastErr = err;
      // small backoff
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  return { ok: false, error: lastErr };
}

// ---------------- EXECUTION ----------------
async function executeActions(actions, chatId) {
  const state = loadState();
  const logs = [];
  const before = snapshotFiles();

  // snapshot for rollback
  state.snapshots = state.snapshots || [];
  state.snapshots.push({ id: crypto.randomUUID(), at: stamp(), snap: before });
  if (state.snapshots.length > 10) state.snapshots = state.snapshots.slice(-10);
  saveState(state);

  for (const a of actions) {
    if (a.type === "web_search_wikipedia") {
      logs.push("🟡 Wikipedia-søk ble ikke kjørt direkte (skal håndteres via godkjenning).");
      continue;
    }

    if (a.type === "npm_install") {
      const pkg = a.package.trim();
      const r = await run(`npm install ${pkg}`, PROJECT_ROOT);
      logs.push(r.ok ? `📦 npm install ${pkg}` : `⚠️ npm install feilet: ${pkg}`);
      if (!r.ok) logs.push(short(r.stderr, 240));
      continue;
    }

    if (a.type === "create_folder") {
      const abs = safeResolve(a.path);
      if (!abs) { logs.push("⛔ Blokkert folder-path"); continue; }
      fs.mkdirSync(abs, { recursive: true });
      logs.push(`📁 Mappe laget: ${a.path}`);
      continue;
    }

    if (a.type === "delete_file") {
      const abs = safeResolve(a.path);
      if (!abs) { logs.push("⛔ Blokkert file-path"); continue; }
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        logs.push(`🗑️ Slettet: ${a.path}`);
      } else {
        logs.push(`ℹ️ Fantes ikke: ${a.path}`);
      }
      continue;
    }

    if (a.type === "modify_package_json") {
      const abs = safeResolve("package.json");
      const content = a.content || "";
      fs.writeFileSync(abs, content, "utf8");
      logs.push("📦 Oppdatert: package.json");
      continue;
    }

    // create/modify file
    const abs = safeResolve(a.path);
    if (!abs) { logs.push(`⛔ Blokkert path: ${a.path}`); continue; }
    fs.writeFileSync(abs, a.content ?? "", "utf8");
    logs.push(`✅ Oppdatert: ${a.path}`);
  }

  const deploy = await gitCommitPush("AI update");
  logs.push(deploy.ok ? deploy.note : `⚠️ ${deploy.note}\n${short(deploy.detail, 260)}`);

  const state2 = loadState();
  pushLog(state2, `Utførte ${actions.length} actions.`);
  state2.lastUpdate = stamp();
  saveState(state2);

  await bot.sendMessage(chatId, `🧾 Logg\n${logs.join("\n")}`);
}

// ---------------- TASK PLANNER ----------------
function defaultPlan(goal) {
  // kort, men profesjonell plan – store ting blir splittet over flere tasks
  return [
    "Lag design-system i CSS: variabler, typografi, spacing, grid og knapper.",
    "Bygg en profesjonell navbar + hero-seksjon med CTA.",
    "Lag About-seksjon med fin layout og tekst.",
    "Lag Projects-seksjon med prosjekt-kort og hover/focus states.",
    "Lag Contact-seksjon med pent skjema (uten backend).",
    "Gjør siden responsiv og ryddig på mobil.",
    "Polish: tilgjengelighet (a11y), små animasjoner, ytelse og SEO-meta."
  ];
}

function statusText(state) {
  const total = state.queue.length + state.done.length + (state.current ? 1 : 0);
  const done = state.done.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    `📊 Status\n` +
    `Mål: ${state.goal || "(ikke satt)"}\n` +
    `Fremdrift: ${pct}%\n` +
    `Pågår: ${state.current || "(ingenting)"}\n` +
    `Kø: ${state.queue.length}\n` +
    `Fullført: ${state.done.length}\n` +
    `Paused: ${state.paused ? "JA" : "NEI"}\n` +
    `Pending approval: ${state.pendingApproval ? "JA" : "NEI"}\n` +
    `Sist oppdatert: ${state.lastUpdate || "(ukjent)"}`
  );
}

// ---------------- WORKER CORE ----------------
async function runNextTask(chatId) {
  const state = loadState();
  if (state.paused) return;
  if (state.pendingApproval) return;
  if (state.current) return;
  if (!state.queue || state.queue.length === 0) return;
  if (!state.goal) return;

  const task = state.queue.shift();
  state.current = task;
  state.lastUpdate = stamp();
  pushLog(state, `Starter oppgave: ${task}`);
  saveState(state);

  await bot.sendMessage(chatId, `🟢 Jobber\n🧩 Oppgave:\n${task}\n\nSkriv /status for fremdrift.`);

  const before = snapshotFiles();
  const modelRes = await callModelWithRetry(state, `Oppgave: ${task}\n\nSvar kun med JSON actions.`);

  if (!modelRes.ok) {
    const s = loadState();
    s.done.push({ task, ok: false, note: "Modell-timeout/feil. Prøv senere." });
    s.current = null;
    s.lastUpdate = stamp();
    pushLog(s, `Modell-feil på oppgave (timeout/feil).`);
    saveState(s);
    return bot.sendMessage(chatId, `⚠️ Modell svarte ikke (timeout).\nJeg hopper videre i køen.\n\nDu kan prøve igjen med /add ${mdEscape(task)}`);
  }

  const obj = extractJson(modelRes.content);
  if (!obj || !Array.isArray(obj.actions)) {
    const s = loadState();
    s.done.push({ task, ok: false, note: "AI ga ikke gyldig JSON." });
    s.current = null;
    s.lastUpdate = stamp();
    pushLog(s, `Ugyldig JSON fra modellen.`);
    saveState(s);
    return bot.sendMessage(chatId, `⚠️ AI returnerte ikke gyldig JSON for denne oppgaven.\nJeg hopper videre.`);
  }

  const actions = obj.actions.slice(0, MAX_ACTIONS_PER_STEP);

  // validate + classify
  const yellowReasons = [];
  const redReasons = [];
  const yellows = [];
  const reds = [];

  for (const a of actions) {
    const r = riskOfAction(a, before);
    if (r.level === "yellow") {
      yellows.push(a);
      yellowReasons.push(`${prettyActionLine(a)} — ${r.reason}`);
    }
    if (r.level === "red") {
      reds.push(a);
      redReasons.push(`${prettyActionLine(a)} — ${r.reason}`);
    }
  }

  if (reds.length > 0) {
    const s = loadState();
    s.done.push({ task, ok: false, note: "Blokkert (ulovlige actions)." });
    s.current = null;
    s.lastUpdate = stamp();
    pushLog(s, `Blokkert røde actions.`);
    saveState(s);

    return bot.sendMessage(
      chatId,
      `⛔ Blokkert (ulovlig i sandbox)\n\n${redReasons.map(mdEscape).join("\n")}\n\nJeg hopper videre.`
    );
  }

  if (yellows.length > 0) {
    const s = loadState();
    s.pendingApproval = {
      task,
      actions,
      createdAt: Date.now(),
      reasons: yellowReasons
    };
    s.lastUpdate = stamp();
    pushLog(s, `Pending approval for oppgave: ${task}`);
    saveState(s);

    return bot.sendMessage(chatId, buildApprovalMessage(task, actions, yellowReasons));
  }

  // green -> execute
  await bot.sendMessage(
    chatId,
    `✅ Plan (auto)\n${actions.map(prettyActionLine).join("\n")}`
  );

  await executeActions(actions, chatId);

  const s = loadState();
  s.done.push({ task, ok: true, note: obj.note || "" });
  s.current = null;
  s.lastUpdate = stamp();
  pushLog(s, `Ferdig oppgave: ${task}`);
  saveState(s);

  await bot.sendMessage(chatId, `🏁 Ferdig\n• ${task}`);
}

// ---------------- APPROVAL HANDLING ----------------
async function approve(chatId) {
  const state = loadState();
  if (!state.pendingApproval) return bot.sendMessage(chatId, "ℹ️ Ingen pending godkjenning.");

  const pending = state.pendingApproval;
  state.pendingApproval = null;
  state.lastUpdate = stamp();
  pushLog(state, `Godkjent: ${pending.task}`);
  saveState(state);

  // handle wikipedia searches safely (if present)
  const wikiAction = pending.actions.find((a) => a.type === "web_search_wikipedia");
  if (wikiAction) {
    await bot.sendMessage(chatId, `🌐 Henter Wikipedia: "${wikiAction.query}" …`);
    const wiki = await wikiSummary(wikiAction.query);

    if (!wiki.ok) {
      const s = loadState();
      s.done.push({ task: pending.task, ok: false, note: `Wikipedia-feil: ${wiki.error}` });
      s.current = null;
      s.lastUpdate = stamp();
      pushLog(s, `Wikipedia-feil: ${wiki.error}`);
      saveState(s);
      return bot.sendMessage(chatId, `⚠️ Wikipedia-feil: ${wiki.error}`);
    }

    // ask model again with provided data, but forbid another web_search
    const extraData =
      `DATA (Wikipedia):\nTitle: ${wiki.title}\nURL: ${wiki.url}\nExtract: ${wiki.extract}\n\n` +
      `BRUK dette som fakta. Ikke be om mer web-søk.`;

    const state2 = loadState();
    const modelRes = await callModelWithRetry(
      state2,
      `Oppgave: ${pending.task}\n\nLag nå kun fil-endringer. IKKE web_search_wikipedia. Svar kun med JSON.`,
      extraData
    );

    if (!modelRes.ok) {
      const s = loadState();
      s.done.push({ task: pending.task, ok: false, note: "Timeout etter Wikipedia-data." });
      s.current = null;
      s.lastUpdate = stamp();
      pushLog(s, `Timeout etter Wikipedia-data.`);
      saveState(s);
      return bot.sendMessage(chatId, "⚠️ Modell-timeout etter Wikipedia. Prøv /add på nytt senere.");
    }

    const obj2 = extractJson(modelRes.content);
    if (!obj2 || !Array.isArray(obj2.actions)) {
      const s = loadState();
      s.done.push({ task: pending.task, ok: false, note: "Ugyldig JSON etter Wikipedia." });
      s.current = null;
      s.lastUpdate = stamp();
      pushLog(s, `Ugyldig JSON etter Wikipedia.`);
      saveState(s);
      return bot.sendMessage(chatId, "⚠️ Ugyldig JSON etter Wikipedia. Prøv /add på nytt.");
    }

    const actions2 = obj2.actions.filter((a) => a.type !== "web_search_wikipedia").slice(0, MAX_ACTIONS_PER_STEP);
    const before = snapshotFiles();

    // re-check risk
    const yellowReasons = [];
    const redReasons = [];
    for (const a of actions2) {
      const r = riskOfAction(a, before);
      if (r.level === "yellow") yellowReasons.push(`${prettyActionLine(a)} — ${r.reason}`);
      if (r.level === "red") redReasons.push(`${prettyActionLine(a)} — ${r.reason}`);
    }

    if (redReasons.length) {
      const s = loadState();
      s.done.push({ task: pending.task, ok: false, note: "Blokkert etter Wikipedia-data." });
      s.lastUpdate = stamp();
      pushLog(s, `Blokkert etter Wikipedia-data.`);
      saveState(s);
      return bot.sendMessage(chatId, `⛔ Blokkert etter Wikipedia:\n${redReasons.map(mdEscape).join("\n")}`);
    }

    if (yellowReasons.length) {
      const s = loadState();
      s.pendingApproval = { task: pending.task, actions: actions2, createdAt: Date.now(), reasons: yellowReasons };
      s.lastUpdate = stamp();
      pushLog(s, `Ny pending approval etter Wikipedia.`);
      saveState(s);
      return bot.sendMessage(chatId, buildApprovalMessage(pending.task, actions2, yellowReasons));
    }

    await bot.sendMessage(chatId, `✅ Godkjent. Utfører nå…`);
    await executeActions(actions2, chatId);

    const s = loadState();
    s.done.push({ task: pending.task, ok: true, note: obj2.note || "" });
    s.current = null;
    s.lastUpdate = stamp();
    pushLog(s, `Ferdig (etter wiki): ${pending.task}`);
    saveState(s);

    return bot.sendMessage(chatId, `🏁 Ferdig:\n• ${pending.task}`);
  }

  // normal approval
  await bot.sendMessage(chatId, "✅ Godkjent. Utfører nå…");
  await executeActions(pending.actions, chatId);

  const s = loadState();
  s.done.push({ task: pending.task, ok: true, note: "" });
  s.current = null;
  s.lastUpdate = stamp();
  pushLog(s, `Ferdig (approved): ${pending.task}`);
  saveState(s);

  await bot.sendMessage(chatId, `🏁 Ferdig:\n• ${pending.task}`);
}

async function deny(chatId) {
  const state = loadState();
  if (!state.pendingApproval) return bot.sendMessage(chatId, "ℹ️ Ingen pending godkjenning.");

  const task = state.pendingApproval.task;
  state.pendingApproval = null;
  state.done.push({ task, ok: false, note: "Avvist av bruker." });
  state.current = null;
  state.lastUpdate = stamp();
  pushLog(state, `Avvist: ${task}`);
  saveState(state);

  return bot.sendMessage(chatId, `🛑 Avbrutt.\nOppgaven ble ikke utført:\n• ${task}`);
}

// ---------------- TELEGRAM COMMANDS ----------------
bot.on("message", async (msg) => {
  if (!msg.from || msg.from.id !== ALLOWED_USER_ID) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // store last chat id for worker
  const state0 = loadState();
  state0.lastChatId = chatId;
  saveState(state0);

  // approvals
  if (text.toLowerCase() === "ja") return approve(chatId);
  if (text.toLowerCase() === "nei") return deny(chatId);

  // commands
  if (text === "/status") {
    const state = loadState();
    return bot.sendMessage(chatId, statusText(state));
  }

  if (text === "/queue") {
    const state = loadState();
    const q = state.queue || [];
    if (q.length === 0) return bot.sendMessage(chatId, "📭 Køen er tom.");
    return bot.sendMessage(chatId, `📌 Kø (${q.length})\n` + q.slice(0, 15).map((t, i) => `${i + 1}. ${t}`).join("\n") + (q.length > 15 ? "\n…" : ""));
  }

  if (text === "/log") {
    const state = loadState();
    const lines = state.log || [];
    if (lines.length === 0) return bot.sendMessage(chatId, "ℹ️ Ingen logg ennå.");
    return bot.sendMessage(chatId, "🧾 Siste logg-linjer:\n" + lines.slice(-20).join("\n"));
  }

  if (text === "/pause") {
    const state = loadState();
    state.paused = true;
    state.lastUpdate = stamp();
    pushLog(state, "Pauset av bruker.");
    saveState(state);
    return bot.sendMessage(chatId, "⏸️ Pauset. Skriv /resume for å fortsette.");
  }

  if (text === "/resume") {
    const state = loadState();
    state.paused = false;
    state.lastUpdate = stamp();
    pushLog(state, "Resumet av bruker.");
    saveState(state);
    return bot.sendMessage(chatId, "▶️ Fortsetter. Skriv /status for fremdrift.");
  }

  if (text === "/stop") {
    const state = loadState();
    state.queue = [];
    state.current = null;
    state.pendingApproval = null;
    state.paused = false;
    state.lastUpdate = stamp();
    pushLog(state, "STOP: tømt kø og stoppet.");
    saveState(state);
    return bot.sendMessage(chatId, "🛑 Stoppet og tømt køen.");
  }

  if (text === "/rollback") {
    const state = loadState();
    const snaps = state.snapshots || [];
    if (snaps.length === 0) return bot.sendMessage(chatId, "ℹ️ Ingen snapshots å rulle tilbake til.");

    const last = snaps[snaps.length - 1];
    applySnapshot(last.snap);

    const deploy = await gitCommitPush("Rollback");
    pushLog(state, "Rollback utført.");
    state.lastUpdate = stamp();
    saveState(state);

    return bot.sendMessage(chatId, `↩️ Rullet tilbake til snapshot (${last.at}).\n${deploy.ok ? deploy.note : "⚠️ Rollback push feilet."}`);
  }

  if (text.startsWith("/add ")) {
    const task = text.slice(5).trim();
    if (!task) return bot.sendMessage(chatId, "Skriv: /add <oppgave>");
    const state = loadState();
    state.queue.push(task);
    state.lastUpdate = stamp();
    pushLog(state, `Lagt til i kø: ${task}`);
    saveState(state);
    return bot.sendMessage(chatId, `➕ Lagt til i kø:\n• ${task}`);
  }

  if (text.startsWith("/goal ")) {
    const goal = text.slice(6).trim();
    if (!goal) return bot.sendMessage(chatId, "Skriv: /goal <mål>");

    const state = loadState();
    state.goal = goal;
    state.queue = defaultPlan(goal);
    state.done = [];
    state.current = null;
    state.pendingApproval = null;
    state.paused = false;
    state.lastUpdate = stamp();
    pushLog(state, `Nytt mål: ${goal}`);
    saveState(state);

    return bot.sendMessage(chatId, `🎯 Mål satt\n${goal}\n\n📌 Jeg la inn en plan på ${state.queue.length} oppgaver.\nSkriv /status for å følge med.`);
  }

  // if plain text: add as queue item
  {
    const state = loadState();
    if (!state.goal) {
      state.goal = "Bygg en profesjonell nettside i dette prosjektet";
      state.queue = defaultPlan(state.goal);
      state.done = [];
      state.current = null;
      state.pendingApproval = null;
      state.paused = false;
      pushLog(state, "Auto-goal satt fordi du skrev vanlig tekst.");
    }
    state.queue.push(text);
    state.lastUpdate = stamp();
    pushLog(state, `Ny oppgave (tekst): ${text}`);
    saveState(state);
    return bot.sendMessage(chatId, `📝 Lagt til som oppgave:\n• ${text}\n\nSkriv /status for fremdrift.`);
  }
});

// ---------------- WORKER LOOP ----------------
setInterval(async () => {
  try {
    const state = loadState();
    if (!state.lastChatId) return;
    await runNextTask(state.lastChatId);
  } catch (err) {
    // NEVER crash
    const state = loadState();
    pushLog(state, `Worker-feil: ${err?.message || err}`);
    state.lastUpdate = stamp();
    saveState(state);
  }
}, WORKER_INTERVAL_MS);

console.log("🚀 Agent v4 kjører. Bruk /goal i Telegram for å starte et stort prosjekt.");