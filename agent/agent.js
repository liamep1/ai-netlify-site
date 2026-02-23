const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const token = '8436996818:AAEC6V62w3Eijtm9xI5BZv6JeSiThnki2G4';
const allowedUser = 8397356794;

const projectPath = "C:/Users/liame/ai-netlify-site";
const allowedFiles = ["index.html", "style.css", "script.js", "package.json"];

const safeNpmWhitelist = ["axios", "lodash", "date-fns"];

const bot = new TelegramBot(token, { polling: true });

let pendingApproval = null;

function resolveSafePath(target) {
  const resolved = path.resolve(projectPath, target);
  if (!resolved.startsWith(path.resolve(projectPath))) return null;
  return resolved;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function evaluateRisk(action) {

  if (!action.type) return "red";

  if (action.path) {
    const safe = resolveSafePath(action.path);
    if (!safe) return "red";
  }

  if (action.type === "run_shell") return "red";
  if (action.type === "delete_folder") return "yellow";

  if (action.type === "run_npm_install") {
    if (!safeNpmWhitelist.includes(action.package)) return "yellow";
  }

  if (!allowedFiles.includes(action.path) && action.path) {
    return "yellow";
  }

  return "green";
}

function runGit() {
  return new Promise((resolve) => {
    exec(
      `cd ${projectPath} && git add . && git commit -m "AI update" && git push`,
      (err, stdout, stderr) => {
        if (err) resolve("⚠️ Git-feil");
        else resolve("🚀 Deployet til Netlify");
      }
    );
  });
}

async function executeActions(actions) {

  let log = [];

  for (const action of actions) {

    const risk = evaluateRisk(action);
    if (risk === "red") {
      log.push(`⛔ Blokkert: ${action.type}`);
      continue;
    }

    const fullPath = action.path ? resolveSafePath(action.path) : null;

    switch (action.type) {

      case "create_file":
      case "modify_file":
        fs.writeFileSync(fullPath, action.content || "", "utf8");
        log.push(`📄 ${action.type}: ${action.path}`);
        break;

      case "delete_file":
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          log.push(`🗑️ Slettet: ${action.path}`);
        }
        break;

      case "create_folder":
        fs.mkdirSync(fullPath, { recursive: true });
        log.push(`📁 Mappe laget: ${action.path}`);
        break;

      case "run_npm_install":
        await new Promise(res => {
          exec(`cd ${projectPath} && npm install ${action.package}`, () => {
            log.push(`📦 npm install ${action.package}`);
            res();
          });
        });
        break;

      default:
        log.push(`⚠️ Ukjent action: ${action.type}`);
    }
  }

  const gitResult = await runGit();
  log.push(gitResult);

  return log.join("\n");
}

bot.on('message', async (msg) => {

  if (msg.from.id !== allowedUser) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (pendingApproval && text.toLowerCase() === "ja") {
    const result = await executeActions(pendingApproval);
    pendingApproval = null;
    return bot.sendMessage(chatId, result);
  }

  try {

    const aiResponse = await axios.post(
      'http://127.0.0.1:11434/api/chat',
      {
        model: 'qwen2.5:7b-16k',
        messages: [
          {
            role: 'system',
            content: `
Svar KUN med gyldig JSON.

Format:
{
  "actions": [
    { "type": "...", "path": "...", "content": "...", "package": "..." }
  ]
}

Ingen forklaringer.
Ingen markdown.
`
          },
          { role: 'user', content: text }
        ],
        stream: false
      }
    );

    const parsed = parseJsonSafe(aiResponse.data.message.content);

    if (!parsed || !Array.isArray(parsed.actions)) {
      return bot.sendMessage(chatId, "⚠️ AI returnerte ikke gyldig JSON.");
    }

    const yellowActions = parsed.actions.filter(a => evaluateRisk(a) === "yellow");

    if (yellowActions.length > 0) {
      pendingApproval = parsed.actions;
      return bot.sendMessage(
        chatId,
        `⚠️ Krever godkjenning:\n${JSON.stringify(yellowActions, null, 2)}\n\nSvar JA for å godkjenne.`
      );
    }

    const result = await executeActions(parsed.actions);
    bot.sendMessage(chatId, result);

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠️ Systemfeil.");
  }
});

console.log("🚀 AI Agent klar.");