const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qr = require("qrcode");
const socketIo = require("socket.io");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");
const existsSync = require("fs").existsSync;
const rimraf = require("rimraf").sync; // 用於清除目錄
const { exec } = require("child_process");

class WhatsAppBot {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.groups = new Map();
    this.contacts = new Map();
    this.activeCommands = new Map();
    this.eventHandlers = new Map();
    this.dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
    this.authDir = process.env.AUTH_DIR || path.join(__dirname, "auth");
    this.tempDir = process.env.TEMP_DIR || path.join(__dirname, "temp");
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async reconnect() {
    try {
      await this.destroy();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.initialize();
    } catch (error) {
      console.error("Reconnection failed:", error);
    }
  }

  async cleanupTempFiles() {
    try {
      const files = await fs.readdir(this.tempDir);
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = await fs.stat(filePath);

        // 刪除超過1小時的臨時文件
        if (now - stats.mtime.getTime() > 3600000) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      console.error("Error cleaning up temp files:", error);
    }
  }

  startCleanupSchedule() {
    setInterval(() => this.cleanupTempFiles(), 3600000); // 每小時執行一次
  }

  async loadData() {
    try {
      // 確保目錄存在
      await this.ensureDirectories();

      // 加載群組數據
      const groupsPath = path.join(this.dataDir, "groups.json");
      if (await this.fileExists(groupsPath)) {
        try {
          const groupsData = await fs.readFile(groupsPath, "utf8");
          this.groups = new Map(JSON.parse(groupsData));
        } catch (parseError) {
          console.error("解析群組數據失敗，將使用空數據:", parseError.message);
          console.log("建立備份檔案以保存原始數據");
          // 備份損壞的檔案
          await fs.copyFile(groupsPath, `${groupsPath}.bak.${Date.now()}`);
          // 使用空的 Map
          this.groups = new Map();
        }
      }

      // 加載聯絡人數據
      const contactsPath = path.join(this.dataDir, "contacts.json");
      if (await this.fileExists(contactsPath)) {
        try {
          const contactsData = await fs.readFile(contactsPath, "utf8");
          this.contacts = new Map(JSON.parse(contactsData));
        } catch (parseError) {
          console.error(
            "解析聯絡人數據失敗，將使用空數據:",
            parseError.message
          );
          console.log("建立備份檔案以保存原始數據");
          // 備份損壞的檔案
          await fs.copyFile(contactsPath, `${contactsPath}.bak.${Date.now()}`);
          // 使用空的 Map
          this.contacts = new Map();
        }
      }

      // 加載指令數據
      const commandsPath = path.join(this.dataDir, "commands.json");
      if (await this.fileExists(commandsPath)) {
        try {
          const commandsData = await fs.readFile(commandsPath, "utf8");
          this.activeCommands = new Map(JSON.parse(commandsData));
        } catch (parseError) {
          console.error("解析指令數據失敗，將使用空數據:", parseError.message);
          console.log("建立備份檔案以保存原始數據");
          // 備份損壞的檔案
          await fs.copyFile(commandsPath, `${commandsPath}.bak.${Date.now()}`);
          // 使用空的 Map
          this.activeCommands = new Map();
        }
      }

      // 數據載入後立即保存一份有效的備份
      await Promise.all([
        this.saveData("groups"),
        this.saveData("contacts"),
        this.saveData("commands"),
      ]);
    } catch (error) {
      console.error("Error loading data:", error);
      // 初始化空的資料結構，確保應用可以啟動
      this.groups = new Map();
      this.contacts = new Map();
      this.activeCommands = new Map();
    }
  }

  async fileExists(path) {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async saveData(type) {
    try {
      const filename = `${type}.json`;
      const filePath = path.join(this.dataDir, filename);
      const data =
        type === "groups"
          ? this.groups
          : type === "contacts"
          ? this.contacts
          : this.activeCommands;

      await fs.writeFile(
        filePath,
        JSON.stringify(Array.from(data.entries()), null, 2)
      );
    } catch (error) {
      console.error(`Error saving ${type}:`, error);
    }
  }

  initialize() {
    // 清除潛在的鎖檔案先
    try {
      const sessionPath = path.join(this.authDir, "session-whatsapp-bot");
      const lockFile = path.join(sessionPath, "SingletonLock");
      if (existsSync(lockFile)) {
        rimraf(lockFile);
        console.log("預先清除鎖檔案 SingletonLock");
      }
    } catch (e) {
      console.log("清除鎖檔案時出錯 (可忽略):", e.message);
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.authDir,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH || null,
      },
      webVersionCache: {
        type: "remote",
        remotePath:
          "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1020491273-alpha.html",
      },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", // 使用與您環境匹配的用戶代理
      fallbackUserAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    const functionDir = path.join(__dirname, "data", "functions");
    if (!existsSync(functionDir)) {
      fs.mkdir(functionDir, { recursive: true });
    }

    console.log("正在初始化 WhatsApp 客戶端，嘗試恢復會話...");
    this.setupEventHandlers();

    return this.client.initialize().catch((error) => {
      console.error("初始化客戶端失敗:", error);
    });
  }

  async ensureDirectories() {
    const dirs = [this.dataDir, this.authDir, this.tempDir];

    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) {
          await fs.mkdir(dir, { recursive: true });
          console.log(`Created directory: ${dir}`);
        }
      } catch (error) {
        console.error(`Error creating directory ${dir}:`, error);
        throw error;
      }
    }
  }

  // 監聽事件
  setupEventHandlers() {
    if (!this.client) return;
    // 先移除所有事件監聽，避免重複
    this.client.removeAllListeners && this.client.removeAllListeners();

    // 新增: 從函數檔案中提取實際代碼內容的方法
    this.extractFunctionCode = async (filePath) => {
      try {
        const content = await fs.readFile(filePath, "utf8");
        // 移除 module.exports = async function(msg, client) { 和最後的 }
        const match = content.match(
          /module\.exports = async function\(msg, client\) {\n?([\s\S]*?)\n?}$/
        );
        if (match && match[1]) {
          return match[1].trim();
        }
        return content; // 如果無法匹配，返回原始內容
      } catch (error) {
        console.error("讀取函數檔案失敗:", error);
        return "// 無法讀取函數內容";
      }
    };

    // 統一註冊各種消息相關的事件處理
    this.client.on("message", (msg) => this.handleMessage(msg));
    this.client.on("message_create", (msg) => {
      if (msg.fromMe) {
        this.handleMessage(msg);
      }
    });
    this.client.on("message_reaction", (reaction) =>
      this.handleReaction(reaction)
    );
  }

  async updateGroups() {
    if (this.isShuttingDown) return; // 關閉中則不執行
    try {
      const chats = await this.client.getChats();
      const groupChats = chats.filter((chat) => chat.isGroup);
      groupChats.forEach((group) => {
        this.groups.set(group.id._serialized, {
          id: group.id._serialized,
          name: group.name,
          description: group.description || "",
        });
      });
      await this.saveData("groups");
      console.log("Groups updated successfully.");
    } catch (error) {
      if (!this.isShuttingDown) {
        console.error("Error updating groups:", error);
      }
    }
  }

  // 處理表情反應（將調用 processMessageOrReaction）
  async handleReaction(reaction) {
    if (this.isShuttingDown) return;

    try {
      console.log("收到表情反應原始資料:", JSON.stringify(reaction, null, 2));

/*       // 忽略自己發送的表情反應
      if (reaction.senderId === this.client.info.wid._serialized) {
        console.log("忽略自己發送的表情反應");
        return;
      } */

      // 獲取必要資訊
      const emoji = reaction.reaction;
      const messageId =
        reaction.msgId && reaction.msgId._serialized
          ? reaction.msgId._serialized
          : null;

      // 重要：從 reaction.msgId 獲取正確的聊天 ID
      // 確保我們使用消息本身的 remote 而不是表情反應的 senderId
      const chatId =
        reaction.msgId && reaction.msgId.remote
          ? reaction.msgId.remote
          : reaction.senderId;

      if (!emoji) {
        console.log("表情反應缺少必要資訊(表情符號)，無法處理");
        return;
      }

      if (!chatId) {
        console.log("表情反應缺少必要資訊(聊天ID)，無法處理");
        return;
      }

      console.log(`處理表情反應: ${emoji} 來自 ${chatId}`);

      // 嘗試獲取聊天對象以檢查是否為群組
      let isGroup = false;
      try {
        const chat = await this.client.getChatById(chatId);
        isGroup = chat.isGroup;
      } catch (error) {
        console.log("無法確定聊天類型，假設為個人聊天");
        isGroup = chatId.includes("@g.us");
      }

      // 創建一個模擬消息對象，用於統一處理
      const simulatedMsg = {
        type: "reaction",
        reaction: emoji,
        from: reaction.senderId, // 表情反應發送者
        to: chatId, // 聊天ID
        id: {
          _serialized: `simulated_${Date.now()}_${Math.random()
            .toString(36)
            .substring(2, 10)}`,
          fromMe: false,
          remote: chatId,
        },
        // 提供回覆功能 - 直接發送到聊天，而不是回覆特定訊息
        reply: async (content) => {
          try {
            await this.client.sendMessage(chatId, content);
            return true;
          } catch (err) {
            console.error("回覆訊息失敗:", err);
            return false;
          }
        },
        getChat: async () => {
          try {
            return await this.client.getChatById(chatId);
          } catch (error) {
            console.error("獲取聊天失敗:", error);
            // 返回基本的聊天對象
            return {
              id: { _serialized: chatId },
              isGroup: isGroup,
            };
          }
        },
      };

      // 使用統一的處理函數處理此表情反應
      await this.processMessageOrReaction(simulatedMsg);
    } catch (error) {
      console.error("處理表情反應時出錯:", error);
    }
  }

  // 處理消息（將調用 processMessageOrReaction）
  async handleMessage(msg) {
    if (this.isShuttingDown) return;

    // 特殊處理：忽略系統自身發送的幫助信息
    if (
      msg.fromMe &&
      (msg.body.startsWith("*Command List*") ||
        msg._data.isForwarded ||
        msg._data.quotedMsg)
    ) {
      console.log("忽略系統自身發送的幫助信息，避免循環觸發");
      return;
    }

    // 使用統一的處理函數處理此消息
    await this.processMessageOrReaction(msg);
  }

  // 統一處理消息和表情反應的核心函數
  async processMessageOrReaction(data) {
    try {
      // 確定是消息還是表情反應
      const isReaction = data.type === "reaction";
      let chat;

      if (isReaction) {
        // 表情反應
        chat = await data.getChat();
      } else {
        // 普通消息
        chat = await data.getChat();
      }

      const sourceId = chat.id._serialized;
      const isGroup = chat.isGroup;
      const messageContent = isReaction ? "" : data.body || "";

      // 收集匹配的指令
      const matchedCommands = [];

      // 檢查每個指令
      for (const command of this.activeCommands.values()) {
        // 檢查目標限制
        const isTargetMatch = command.targets.some((target) => {
          if (isGroup) {
            return target.type === "group" && target.id === sourceId;
          } else {
            return target.type === "contact" && target.id === sourceId;
          }
        });

        if (!isTargetMatch) continue;

        // 檢查觸發條件
        for (const trigger of command.triggers) {
          let shouldTrigger = false;

          // 處理表情反應
          if (isReaction && trigger.hasReaction) {
            if (trigger.reaction && trigger.reaction !== data.reaction)
              continue;
            shouldTrigger = true;
          }
          // 處理普通消息
          else if (!isReaction) {
            const content = trigger.toLowerCase
              ? messageContent.toLowerCase()
              : messageContent;
            const isReply =
              data.hasQuotedMsg || (data._data && data._data.quotedMsg);
            const hasMedia =
              data.hasMedia || (data._data && data._data.hasMedia);

            // 時間範圍檢查
            let isInTimeRange = true;
            if (trigger.timeRange) {
              const now = new Date();
              const currentTime = now.getHours() * 60 + now.getMinutes();

              const [startHour, startMinute] = trigger.startTime
                .split(":")
                .map(Number);
              const [endHour, endMinute] = trigger.endTime
                .split(":")
                .map(Number);

              const startTimeMinutes = startHour * 60 + startMinute;
              const endTimeMinutes = endHour * 60 + endMinute;

              if (startTimeMinutes <= endTimeMinutes) {
                isInTimeRange =
                  currentTime >= startTimeMinutes &&
                  currentTime <= endTimeMinutes;
              } else {
                isInTimeRange =
                  currentTime >= startTimeMinutes ||
                  currentTime <= endTimeMinutes;
              }

              if (!isInTimeRange) continue;
            }

            // 正則表達式觸發條件
            if (trigger.isRegex) {
              try {
                const regex = new RegExp(
                  trigger.keyword,
                  trigger.toLowerCase ? "i" : undefined
                );
                if (regex.test(content)) {
                  if (trigger.quotedMsg && isReply) shouldTrigger = true;
                  else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
                  else if (trigger.timeRange && isInTimeRange)
                    shouldTrigger = true;
                  else if (
                    !trigger.quotedMsg &&
                    !trigger.hasMedia &&
                    !trigger.timeRange
                  )
                    shouldTrigger = true;
                }
              } catch (e) {
                console.log("正則表達式錯誤:", e);
              }
            }
            // 關鍵字觸發條件
            else if (trigger.keyword) {
              const match = trigger.startsWith
                ? content.startsWith(trigger.keyword)
                : content.includes(trigger.keyword);
              if (match) {
                if (trigger.quotedMsg && isReply) shouldTrigger = true;
                else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
                else if (trigger.timeRange && isInTimeRange)
                  shouldTrigger = true;
                else if (
                  !trigger.quotedMsg &&
                  !trigger.hasMedia &&
                  !trigger.timeRange
                )
                  shouldTrigger = true;
              }
            }
            // 特殊觸發條件（無關鍵詞）
            else {
              if (trigger.quotedMsg && isReply) shouldTrigger = true;
              else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
              else if (trigger.timeRange && isInTimeRange) shouldTrigger = true;
            }
          }

          if (shouldTrigger) {
            matchedCommands.push(command);
            break; // 找到匹配的觸發條件後跳出循環
          }
        }
      }

      // 執行匹配的指令
      if (matchedCommands.length > 0) {
        try {
          await this.sendResponse(matchedCommands[0], data);
          console.log(
            `執行指令: ${matchedCommands[0].id}, 來源: ${
              isReaction ? "表情反應" : "消息"
            }`
          );
        } catch (error) {
          console.error("執行指令失敗:", error);
          try {
            await data.reply("執行指令時出錯，請稍後重試或聯繫管理員。");
          } catch (replyError) {
            console.error("回覆錯誤通知失敗:", replyError);
          }
        }
      }
    } catch (error) {
      console.error("處理消息/表情反應時出錯:", error);
    }
  }

  async handleDisconnect(reason) {
    // 只有在非用戶主動退出時才嘗試重新連接
    if (reason !== "user" && this.retryCount < this.maxRetries) {
      console.log("Attempting to reconnect...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.initialize();
    }
  }

  async runDynamicFunction(id, msg) {
    const funcPath = path.join(this.dataDir, "functions", `${id}.js`);
    if (!existsSync(funcPath)) {
      return "找不到對應的 function 指令檔案。";
    }
    try {
      // 清除 require 快取，確保每次都載入最新內容
      delete require.cache[require.resolve(funcPath)];
      const fn = require(funcPath);
      if (typeof fn !== "function") return "function 檔案未正確導出函式。";
      // 支援 async function
      return await fn(msg, this.client);
    } catch (e) {
      return `執行 function 指令時發生錯誤：${e.message}`;
    }
  }

  async sendResponse(command, msg) {
    const sender = msg.fromMe ? msg.to : msg.from;
    const chat = await msg.getChat();
    const isReaction = msg.type === "reaction"; // 檢查是否為表情反應

    try {
      switch (command.response.type) {
        case "text":
          // 直接回覆文字訊息，表情反應不使用 quotedMessageId
          await this.client.sendMessage(sender, command.response.content, 
            isReaction ? {} : { quotedMessageId: msg.id._serialized }
          );
          break;
        case "image": {
          // 處理圖片，表情反應不使用 quotedMessageId
          try {
            const media = new MessageMedia(
              "image/jpeg",
              command.response.content.replace(
                /^data:image\/(png|jpeg|jpg);base64,/,
                ""
              ),
              "image.jpg"
            );
            await this.client.sendMessage(sender, media,
              isReaction ? {} : { quotedMessageId: msg.id._serialized }
            );
            console.log("圖片發送成功");
          } catch (error) {
            console.error("圖片發送失敗:", error);
            await this.client.sendMessage(
              sender,
              "圖片發送失敗，請再試一次。",
              isReaction ? {} : { quotedMessageId: msg.id._serialized }
            );
          }
          break;
        }
        case "video": {
          // 處理影片，表情反應不使用 quotedMessageId
          try {
            const videoPath = path.join(this.dataDir, command.response.content);
            const media = MessageMedia.fromFilePath(videoPath);
            await this.client.sendMessage(sender, media,
              isReaction ? {} : { quotedMessageId: msg.id._serialized }
            );
            console.log("影片發送成功");
          } catch (error) {
            console.error("影片發送流程錯誤:", error);
            await this.client.sendMessage(
              sender,
              "影片發送失敗，請再試一次或通知管理員檢查影片檔案大小。",
              isReaction ? {} : { quotedMessageId: msg.id._serialized }
            );
          }
          break;
        }
        case "function": {
          // 處理函數指令
          try {
            const result = await this.runDynamicFunction(command.id, msg);
            // 如果函數已經處理了回覆，就不需要再執行
            if (result && typeof result === "string") {
              await this.client.sendMessage(sender, result,
                isReaction ? {} : { quotedMessageId: msg.id._serialized }
              );
            }
          } catch (error) {
            console.error("執行函數指令錯誤:", error);
            await this.client.sendMessage(
              sender,
              `執行函數時發生錯誤: ${error.message}`,
              isReaction ? {} : { quotedMessageId: msg.id._serialized }
            );
          }
          break;
        }
      }
    } catch (error) {
      console.error("執行指令回應錯誤:", error);
      // 確保即使出錯也發送通知，表情反應不使用 quotedMessageId
      try {
        await this.client.sendMessage(
          sender,
          "執行指令時出錯，請稍後重試或通知管理員。",
          isReaction ? {} : { quotedMessageId: msg.id._serialized }
        );
      } catch (e) {
        console.error("發送錯誤通知失敗:", e);
      }
    }
  }

  async searchGroup(name) {
    if (!this.isInitialized) {
      throw new Error("WhatsApp client not initialized");
    }

    const chats = await this.client.getChats();
    const group = chats.find((chat) => chat.isGroup && chat.name === name);

    if (!group) {
      throw new Error("找不到群組");
    }

    const groupData = {
      id: group.id._serialized,
      name: group.name,
      description: group.description || "",
    };

    this.groups.set(group.id._serialized, groupData);
    await this.saveData("groups");

    return groupData;
  }

  on(event, handler) {
    this.eventHandlers.set(event, handler);
  }

  async destroy() {
    this.isShuttingDown = true; // 標記正在關閉
    if (this.client) {
      if (this.eventHandlers.has("disconnected")) {
        try {
          await this.eventHandlers.get("disconnected")();
        } catch (error) {
          console.error("Error in destroy event handler:", error);
        }
      }

      // 使用更優雅的方式關閉客戶端，避免刪除認證數據
      try {
        console.log("正常關閉 WhatsApp 客戶端，保留認證資料...");
        // 等待瀏覽器優雅關閉
        await this.client.destroy();
      } catch (e) {
        console.log("關閉客戶端時出錯，但可以忽略:", e.message);
      }

      this.client = null;
      this.isInitialized = false;
      console.log("客戶端已正確關閉，認證資料已保留");
    }
    this.isShuttingDown = false; // 關閉結束
  }
}

// Create Express app and WhatsApp bot instance
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e8,
  path: "/socket.io/",
  connectTimeout: 45000,
  retries: 3,
});
const bot = new WhatsAppBot();

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));
app.use(bodyParser.urlencoded({ limit: "100mb", extended: true }));
// 修改靜態文件服務
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/data/functions",
  express.static(path.join(__dirname, "data", "functions"))
);
app.use("/data/video", express.static(path.join(__dirname, "data", "video")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Console 功能
let logHistory = [];
const maxLogEntries = 1000;

// 添加一個單獨的函數用於向前端發送日誌
function addLogEntry(level, message) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
  };

  logHistory.push(entry);
  if (logHistory.length > maxLogEntries) {
    logHistory.shift();
  }

  // 通知前端更新日誌
  io.emit("console-log", entry);
}

// 替換原有的 console 方法
["log", "error", "warn", "info"].forEach((level) => {
  const originalMethod = console[level];
  console[level] = (...args) => {
    originalMethod.apply(console, args);
    const message = args
      .map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(" ");
    addLogEntry(level, message);
  };
});

// API 路由
app.get("/api/logs", (req, res) => {
  const { level } = req.query;
  let filteredLogs = logHistory;

  if (level && level !== "all") {
    filteredLogs = logHistory.filter((log) => log.level === level);
  }

  res.json(filteredLogs);
});

// 清除日誌
app.post("/api/logs/clear", (req, res) => {
  logHistory = [];
  io.emit("logs-cleared");
  res.sendStatus(200);
});

// 添加錯誤處理
io.on("error", (error) => {
  console.error("Socket.IO Error:", error);
});

// Setup bot event handlers
bot.on("qr", async (qrData) => {
  try {
    // 確保目錄存在
    const qrDir = path.join(__dirname, "temp");
    await fs.mkdir(qrDir, { recursive: true });

    // 生成唯一的文件名
    const fileName = `qr_${Date.now()}.jpg`;
    const filePath = path.join(qrDir, fileName);

    // 生成 QR code 並保存為 JPG
    await qr.toFile(filePath, qrData, {
      type: "jpg",
      quality: 0.9,
      margin: 1,
      width: 600,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

    // 讀取文件並轉換為 base64
    const imageBuffer = await fs.readFile(filePath);
    const base64Image = `data:image/jpeg;base64,${imageBuffer.toString(
      "base64"
    )}`;

    // 發送到前端
    io.emit("qr", base64Image);

    // 刪除臨時文件
    await fs.unlink(filePath);
  } catch (error) {
    console.error("Error generating QR code:", error);
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: true,
    message: err.message || "服務器內部錯誤",
  });
});

bot.on("ready", () => {
  io.emit("ready", "WhatsApp is ready!");
});

bot.on("disconnected", () => {
  io.emit("disconnected");
});

bot.on("groupUpdate", (groups) => {
  io.emit("groupUpdate", groups);
});

// API Routes
app.get("/api/groups", (req, res) => {
  res.json(Array.from(bot.groups.values()));
});

app.get("/api/contacts", (req, res) => {
  res.json(Array.from(bot.contacts.values()));
});

app.get("/api/commands", async (req, res) => {
  try {
    const commands = Array.from(bot.activeCommands.values());
    res.json(commands);
  } catch (error) {
    console.error("Error fetching commands:", error);
    res.status(500).json({
      error: true,
      message: "獲取指令列表失敗",
    });
  }
});

app.get("/api/commands/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const command = bot.activeCommands.get(id);

    if (!command) {
      return res.status(404).json({ error: "找不到指令" });
    }

    // 處理函數類型的回應，從檔案獲取最新內容
    if (command.response && command.response.type === "function") {
      const funcPath = path.join(__dirname, "data", command.response.content);
      if (existsSync(funcPath)) {
        // 使用新增的 extractFunctionCode 方法獲取函數內容
        const code = await bot.extractFunctionCode(funcPath);
        const returnCommand = { ...command };
        returnCommand.response = { ...command.response, content: code };
        return res.json(returnCommand);
      }
    }

    res.json(command);
  } catch (error) {
    console.error("獲取指令詳情失敗:", error);
    res.status(500).json({ message: "獲取指令詳情失敗: " + error.message });
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    socketio: io.engine.clientsCount > 0 ? "connected" : "waiting",
    bot: {
      initialized: bot.isInitialized,
      retryCount: bot.retryCount,
    },
  });
});

app.post("/api/groups/search", async (req, res) => {
  try {
    const group = await bot.searchGroup(req.body.name);
    res.json({ success: true, group });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post("/api/contacts", async (req, res) => {
  try {
    const { prefix, number, name } = req.body;
    const id = `${prefix}${number}@c.us`;
    const contactData = {
      id,
      name,
      number: `${prefix}${number}`,
    };

    bot.contacts.set(id, contactData);
    await bot.saveData("contacts");
    res.json({ success: true, contact: contactData });
  } catch (error) {
    res.status(500).json({ message: "添加聯絡人失敗" });
  }
});

app.post("/api/commands", async (req, res) => {
  try {
    const commandData = req.body;
    commandData.id = Date.now().toString();

    // 如果是 function 指令，寫入 data/functions/{id}.js
    if (commandData.response && commandData.response.type === "function") {
      const funcDir = path.join(__dirname, "data", "functions");
      if (!existsSync(funcDir)) {
        await fs.mkdir(funcDir, { recursive: true });
      }
      const funcPath = path.join(funcDir, `${commandData.id}.js`);

      // 檢查內容是否已經包含 module.exports
      let code = commandData.response.content;
      if (!code.includes("module.exports")) {
        // 包裝成 module.exports = async function(msg, client) { ... }
        code = `module.exports = async function(msg, client) {\n${code}\n}`;
      }

      await fs.writeFile(funcPath, code, "utf8");
      // 存檔案路徑代替原始內容到 commands.json
      const originalContent = commandData.response.content;
      commandData.response.content = `functions/${commandData.id}.js`;
      commandData.response._contentBackup =
        originalContent.substring(0, 100) + "..."; // 保存前100個字元作為備份
    }
    // 如果是 video 指令，寫入 data/video/{id}.mp4
    else if (commandData.response && commandData.response.type === "video") {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const videoPath = path.join(videoDir, `${commandData.id}.mp4`);
      // 將 base64 內容寫入檔案
      const base64Data = commandData.response.content.replace(
        /^data:video\/mp4;base64,/,
        ""
      );
      await fs.writeFile(videoPath, Buffer.from(base64Data, "base64"));
      // 存檔案路徑代替原始內容到 commands.json
      commandData.response.content = `video/${commandData.id}.mp4`;
    }
    bot.activeCommands.set(commandData.id, commandData);
    await bot.saveData("commands");
    res.json({ success: true, command: commandData });
  } catch (error) {
    console.error("添加指令失敗:", error);
    res.status(500).json({ message: "添加指令失敗: " + error.message });
  }
});

app.put("/api/commands/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const commandData = req.body;
    commandData.id = id;

    // 如果是 function 指令，寫入 data/functions/{id}.js
    if (commandData.response && commandData.response.type === "function") {
      const funcDir = path.join(__dirname, "data", "functions");
      if (!existsSync(funcDir)) {
        await fs.mkdir(funcDir, { recursive: true });
      }
      const funcPath = path.join(funcDir, `${id}.js`);
      const code = `module.exports = async function(msg, client) {\n${commandData.response.content}\n}`;
      await fs.writeFile(funcPath, code, "utf8");
      // 存檔案路徑代替原始內容
      const originalContent = commandData.response.content;
      commandData.response.content = `functions/${id}.js`;
      commandData.response._contentBackup =
        originalContent.substring(0, 100) + "..."; // 保存前100個字元作為備份
    }
    // 如果是 video 指令，寫入 data/video/{id}.mp4
    else if (commandData.response && commandData.response.type === "video") {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const videoPath = path.join(videoDir, `${id}.mp4`);
      // 檢查內容是否已經是檔案路徑
      if (!commandData.response.content.startsWith("video/")) {
        // 將 base64 內容寫入檔案
        const base64Data = commandData.response.content.replace(
          /^data:video\/mp4;base64,/,
          ""
        );
        await fs.writeFile(videoPath, Buffer.from(base64Data, "base64"));
        // 存檔案路徑代替原始內容到 commands.json
        commandData.response.content = `video/${id}.mp4`;
      }
    }
    bot.activeCommands.set(id, commandData);
    await bot.saveData("commands");
    res.json({ success: true, command: commandData });
  } catch (error) {
    console.error("更新指令失敗:", error);
    res.status(500).json({ message: "更新指令失敗: " + error.message });
  }
});

app.delete("/api/groups/:id", async (req, res) => {
  try {
    bot.groups.delete(req.params.id);
    await bot.saveData("groups");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "刪除群組失敗" });
  }
});

app.delete("/api/contacts/:id", async (req, res) => {
  try {
    bot.contacts.delete(req.params.id);
    await bot.saveData("contacts");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "刪除聯絡人失敗" });
  }
});

app.delete("/api/commands/:id", async (req, res) => {
  try {
    bot.activeCommands.delete(req.params.id);
    await bot.saveData("commands");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "刪除指令失敗" });
  }
});

// Terminal API：僅允許 npm install 指令
app.post("/api/terminal", async (req, res) => {
  try {
    const { command } = req.body;
    // 僅允許 npm install/i 指令，且不能有 &&、;、| 等危險符號
    if (
      !/^npm\s+(i|install)\s+[a-zA-Z0-9@\-_/]+(\s+[a-zA-Z0-9@\-_/]+)*$/.test(
        command.trim()
      )
    ) {
      return res.json({
        error: "只允許執行 npm install 指令，且不能包含特殊符號。",
      });
    }
    command = "sudo " + command; // 加上 sudo
    exec(
      command,
      { cwd: process.cwd(), timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          return res.json({ error: stderr || err.message });
        }
        res.json({ output: stdout || stderr || "(無輸出)" });
      }
    );
  } catch (e) {
    res.json({ error: e.message });
  }
});

// 新增 /api/update-html 路由
app.post("/api/update-html", async (req, res) => {
  const { exec } = require("child_process");
  const htmlPath = path.join(__dirname, "public", "index.html");
  const url =
    "https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/public/index.html";
  exec(`curl -o "${htmlPath}" "${url}"`, (err, stdout, stderr) => {
    if (err) {
      return res.json({ error: stderr || err.message });
    }
    res.json({ success: true });
  });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });

  socket.on("connect-bot", () => {
    if (!bot.isInitialized) {
      bot.initialize().catch((error) => {
        console.error("Bot initialization error:", error);
        socket.emit("error", "Bot initialization failed");
      });
    }
  });

  // Commented out to decouple bot lifecycle from socket.io connections
  socket.on("disconnect-bot", async () => {
    try {
      await bot.destroy();
    } catch (error) {
      console.error("Error disconnecting bot:", error);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Client disconnected:", socket.id, reason);
  });

  try {
    socket.emit("updateData", {
      groups: Array.from(bot.groups.values()),
      contacts: Array.from(bot.contacts.values()),
      commands: Array.from(bot.activeCommands.values()),
      botStatus: {
        initialized: bot.isInitialized,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error sending initial data:", error);
  }
});

// Start server
const startServer = async () => {
  await bot.loadData();

  const PORT = process.env.PORT || 3333;
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer();
