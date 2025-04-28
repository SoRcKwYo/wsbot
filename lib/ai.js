let fetch = global.fetch;
if (!fetch) {
  fetch = (...args) => import("node-fetch").then((m) => m.default(...args));
}
const fs = require("fs");
const path = require("path");

// OpenRouter API configuration
const OPENROUTER_API_KEY =
  "";
const MODEL = "";
const API_URL = "";

// 對話歷史配置
const HISTORY_DIR = path.join(__dirname, "..", "chat_history");
const MAX_HISTORY = 5;

// 確保歷史記錄目錄存在
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function getUserHistory(userId) {
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9]/g, "_");
  const historyPath = path.join(HISTORY_DIR, `${sanitizedUserId}.json`);
  try {
    if (fs.existsSync(historyPath)) {
      const historyData = fs.readFileSync(historyPath, "utf8");
      return JSON.parse(historyData);
    }
  } catch (error) {}
  return [];
}

function updateUserHistory(userId, userMessage, aiMessage) {
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9]/g, "_");
  const historyPath = path.join(HISTORY_DIR, `${sanitizedUserId}.json`);
  try {
    let history = getUserHistory(userId);
    history.push(userMessage);
    history.push(aiMessage);
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");
  } catch (error) {}
}
const userSystemPrompts = {};

const defaultSystemPrompt = "";

const messageText = msg.body.trim();
const userId = msg.author || msg.from || "command_execution_user";

if (msg.react) await msg.react("⭕");

// 取得 prompt
let prompt = messageText.substring(4).trim();

// 嘗試取得引用訊息內容
if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === "function") {
  try {
    const quotedMessage = await msg.getQuotedMessage();
    if (quotedMessage && quotedMessage.body) {
      prompt = `${quotedMessage.body.trim()} ${prompt}`;
    }
  } catch (e) {}
}

// 呼叫 AI
try {
  const history = getUserHistory(userId);
  const systemPrompt = userSystemPrompts[userId] || defaultSystemPrompt;
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: prompt },
  ];

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages,
    }),
  });

  if (!response.ok) {
    const errorMsg = "AI服務異常，請稍後再試。";
    if (msg.react) await msg.react("❌");
    return errorMsg;
  }

  const data = await response.json();
  const aiContent =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content
      ? data.choices[0].message.content
      : null;
  if (!aiContent) {
    const errorMsg = "AI 沒有回應";
    return errorMsg;
  }
  const aiMessage = { role: "assistant", content: aiContent };
  updateUserHistory(userId, { role: "user", content: prompt }, aiMessage);
  return aiContent;
} catch (error) {
  const errorMsg = "處理AI請求時發生錯誤，請稍後重試";
  if (msg.react) await msg.react("❌");
  console.error(error);
  return errorMsg;
}
