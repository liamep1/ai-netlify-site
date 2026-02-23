const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const token = '8436996818:AAEC6V62w3Eijtm9xI5BZv6JeSiThnki2G4';
const allowedUser = 8397356794;
const projectPath = "C:/Users/liame/ai-netlify-site";

const bot = new TelegramBot(token, { polling: true });

let pendingAction = null;

const safeNpmWhitelist = ["axios", "lodash", "date-fns"];

function isSafePath(targetPath) {
  const resolved = path.resolve(projectPath, targetPath);
  return resolved.startsWith(path.resolve(projectPath));
}

function riskLevel(action) {

  if (!action.type) return "red";

  if (action.type === "run_shell") return "red";
  if (action.path && !isSafePath(action.path)) return "red";

  if (action.type === "run_npm_install") {
    if (!safeNpmWhitelist.includes(action.package)) {
      return "yellow";
    }
  }

  if (action.type === "delete_folder") return "yellow";
  if (action.type === "modify_package_json") return "yellow";

  return "green";
}

function runGit(callback) {
  exec(
    `cd ${projectPath} && git add . && git commit -m "AI update" && git push`,
    callback
  );
}

bot.on('message', async (msg) => {

  if (msg.from.id !== allowedUser) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (pendingAction && text.toLowerCase() === "ja") {

    const action = pendingAction;
    pendingAction = null;

    executeAction(action, chatId);
    return;
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
Returner kun JSON:

{
  "action": { ... }
}
`
          },
          { role: 'user', content: text }
        ],
        stream: false
      }
    );

    const aiText = aiResponse.data.message.content.trim();
    let command;

    try {
      command = JSON.parse(aiText);
    } catch {
      return bot.sendMessage(chatId, "⚠️ AI returnerte ikke gyldig JSON.");
    }

    const action = command.action;
    const level = riskLevel(action);

    if (level === "red") {
      return bot.sendMessage(chatId, "⛔ Blokkert av sikkerhetsregler.");
    }

    if (level === "yellow") {
      pendingAction = action;
      return bot.sendMessage(chatId,
        `⚠️ AI ønsker å utføre en risiko-handling:\n` +
        `${JSON.stringify(action, null, 2)}\n\n` +
        `Svar JA for å godkjenne.`
      );
    }

    executeAction(action, chatId);

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠️ Systemfeil.");
  }
});

function executeAction(action, chatId) {

  let log = [];

  const fullPath = action.path ? path.resolve(projectPath, action.path) : null;

  switch (action.type) {

    case "create_file":
    case "modify_file":
      fs.writeFileSync(fullPath, action.content);
      log.push(`📄 ${action.type}: ${action.path}`);
      break;

    case "delete_file":
      fs.unlinkSync(fullPath);
      log.push(`🗑️ Slettet: ${action.path}`);
      break;

    case "run_npm_install":
      exec(`cd ${projectPath} && npm install ${action.package}`, () => {});
      log.push(`📦 npm install ${action.package}`);
      break;

    default:
      log.push("⚠️ Ukjent action.");
  }

  runGit((error) => {
    if (error) {
      log.push("⚠️ Git-feil");
    } else {
      log.push("🚀 Deployet til Netlify");
    }
    bot.sendMessage(chatId, log.join("\n"));
  });
}