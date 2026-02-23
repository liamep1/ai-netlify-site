const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const token = '8436996818:AAEC6V62w3Eijtm9xI5BZv6JeSiThnki2G4'; // <-- bytt denne
const allowedUser = 8397356794;

const projectPath = "C:/Users/liame/ai-netlify-site";
const allowedFiles = ["index.html", "style.css", "script.js"];

const bot = new TelegramBot(token, { polling: true });

console.log("Agent startet...");
bot.on('message', (msg) => {
  console.log("Din Telegram user ID er:", msg.from.id);
});
bot.on('message', async (msg) => {

  if (msg.from.id !== allowedUser) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;

  try {

    const aiResponse = await axios.post(
      'http://127.0.0.1:11434/api/chat',
      {
        model: 'qwen2.5:7b-16k',
        messages: [
          {
            role: 'system',
            content: `
Du returnerer kun JSON.
Format:
{
  "file": "index.html",
  "content": "<full file content>"
}
Kun disse filene er lov:
index.html
style.css
script.js
`
          },
          { role: 'user', content: msg.text }
        ],
        stream: false
      }
    );

    const aiText = aiResponse.data.message.content.trim();

    let command;
    try {
      command = JSON.parse(aiText);
    } catch (e) {
      console.log("AI svarte ikke med JSON:", aiText);
      return bot.sendMessage(chatId, "AI returnerte ikke gyldig JSON.");
    }

    if (!allowedFiles.includes(command.file)) {
      return bot.sendMessage(chatId, "Ikke tillatt fil.");
    }

    const filePath = path.join(projectPath, command.file);

    fs.writeFileSync(filePath, command.content);

    exec(
      `cd ${projectPath} && git add . && git commit -m "AI update" && git push`,
      (error, stdout, stderr) => {

        if (error) {
          console.log(stderr);
          return bot.sendMessage(chatId, "Git-feil.");
        }

        bot.sendMessage(chatId, "🚀 Deployet til Netlify.");
      }
    );

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠️ Feil.");
  }
});