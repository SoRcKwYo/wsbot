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
          console.error("解析聯絡人數據失敗，將使用空數據:", parseError.message);
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
        this.saveData("commands")
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
      const sessionPath = path.join(this.authDir, 'session-whatsapp-bot');
      const lockFile = path.join(sessionPath, 'SingletonLock');
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
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (() => {
          const platform = process.platform;
          
          if (platform === 'darwin') { // macOS
            // 常見的 Chrome 路徑
            const macPaths = [
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
              '/Applications/Chromium.app/Contents/MacOS/Chromium'
            ];
            
            for (const path of macPaths) {
              if (existsSync(path)) return path;
            }

          } else if (platform === 'win32') { // Windows
            // 常見的 Chrome 路徑
            const winPaths = [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
              process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
              process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
              process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
            ];
            
            for (const path of winPaths) {
              if (existsSync(path)) return path;
            }
          }
          return null; // 找不到時回傳 null，讓 puppeteer 使用內建的
        })(),
      },
      webVersionCache: {
        type: "remote",
        remotePath:
          "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1020491273-alpha.html",
      },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', // 使用與您環境匹配的用戶代理
      fallbackUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
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

  setupEventHandlers() {
    if (!this.client) return;
    // 先移除所有事件監聽，避免重複
    this.client.removeAllListeners && this.client.removeAllListeners();

    this.client.on("qr", async (qr) => {
      try {
        if (this.eventHandlers.has("qr")) {
          await this.eventHandlers.get("qr")(qr);
        }
      } catch (error) {
        console.error("Error handling QR code:", error);
      }
    });

    this.client.on("ready", async () => {
      try {
        this.isInitialized = true;
        this.retryCount = 0;
        if (this.eventHandlers.has("ready")) {
          await this.eventHandlers.get("ready")();
        }
        console.log("Client is ready to receive messages.");
        await this.updateGroups();
      } catch (error) {
        console.error("Error in ready event:", error);
      }
    });

    this.client.on("disconnected", async (reason) => {
      try {
        console.log("Client disconnected:", reason);
        this.isInitialized = false;
        if (this.eventHandlers.has("disconnected")) {
          await this.eventHandlers.get("disconnected")();
        }
        await this.handleDisconnect(reason);
      } catch (error) {
        console.error("Error handling disconnect:", error);
      }
    });

    // Register message event to trigger handleMessage
    this.client.on("message", (msg) => this.handleMessage(msg));

    this.client.on("message_create", (msg) => {
      if (msg.fromMe) {
        this.handleMessage(msg);
      }
    });
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

  async handleDisconnect(reason) {
    // 只有在非用戶主動退出時才嘗試重新連接
    if (reason !== "user" && this.retryCount < this.maxRetries) {
      console.log("Attempting to reconnect...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.initialize();
    }
  }

  async handleMessage(msg) {
    if (this.isShuttingDown) return;
    const messageContent = msg.body;
    const sender = msg.fromMe ? msg.to : msg.from;
    const chat = await msg.getChat();

    // 收集所有符合觸發條件的指令
    const matchedCommands = [];
    
    // 檢查每個指令
    for (const command of this.activeCommands.values()) {
      for (const trigger of command.triggers) {
        let shouldTrigger = false;
        const content = trigger.toLowerCase
          ? messageContent.toLowerCase()
          : messageContent;
        const isReply = msg.hasQuotedMsg || (msg._data && msg._data.quotedMsg);
        
        // 正則表達式觸發條件
        if (trigger.isRegex) {
          try {
            const regex = new RegExp(
              trigger.keyword,
              trigger.toLowerCase ? "i" : undefined
            );
            if (regex.test(content)) {
              if (trigger.quotedMsg) {
                shouldTrigger = isReply;
              } else {
                shouldTrigger = true;
              }
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
            if (trigger.quotedMsg) {
              shouldTrigger = isReply;
            } else {
              shouldTrigger = true;
            }
          }
        } 
        // 純回覆觸發條件
        else if (trigger.quotedMsg && !trigger.keyword && !trigger.isRegex) {
          shouldTrigger = isReply;
        }
        
        // 如果這個觸發條件符合，將指令加入匹配列表並跳出循環
        if (shouldTrigger) {
          // 檢查目標對象是否匹配
          const isTargetMatch = command.targets.some((target) => {
            if (chat.isGroup) {
              return target.type === "group" && target.id === chat.id._serialized;
            } else {
              return target.type === "contact" && target.id === sender;
            }
          });
          
          // 如果目標也匹配，則加入到匹配指令列表
          if (isTargetMatch) {
            matchedCommands.push(command);
            break; // 已經找到一個匹配的觸發條件，不用再檢查其他觸發條件
          }
        }
      }
    }
    
    // 執行第一個匹配的指令
    if (matchedCommands.length > 0) {
      await this.sendResponse(matchedCommands[0], msg);
      console.log(`執行指令: ${matchedCommands[0].name || '無名指令'}`);
    }
  }

  // 動態執行 data/functions/{id}.js
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

  // 在 sendResponse 中處理不同的回應類型
  async sendResponse(command, msg) {
    const sender = msg.fromMe ? msg.to : msg.from; 
    const chat = await msg.getChat();
    
    try {
      switch (command.response.type) {
        case "text":
          // 直接回覆文字訊息
          await this.client.sendMessage(sender, command.response.content, {
            quotedMessageId: msg.id._serialized
          });
          break;
        case "image": {
          // 處理圖片
          try {
            const media = new MessageMedia(
              "image/jpeg",
              command.response.content.replace(/^data:image\/(png|jpeg|jpg);base64,/, ""),
              "image.jpg"
            );
            await this.client.sendMessage(sender, media, {
              quotedMessageId: msg.id._serialized
            });
            console.log("圖片發送成功");
          } catch (error) {
            console.error("圖片發送失敗:", error);
            await this.client.sendMessage(sender, "圖片發送失敗，請再試一次。", {
              quotedMessageId: msg.id._serialized
            });
          }
          break;
        }
        case "video": {
          // 處理影片
          try {
            const videoPath = path.join(this.dataDir, command.response.content);
            const media = MessageMedia.fromFilePath(videoPath);
            await this.client.sendMessage(sender, media, {
              quotedMessageId: msg.id._serialized
            });
            console.log("影片發送成功");
          } catch (error) {
            console.error("影片發送流程錯誤:", error);
            await this.client.sendMessage(sender, "影片發送失敗，請再試一次或通知管理員檢查影片檔案大小。", {
              quotedMessageId: msg.id._serialized
            });
          }
          break;
        }
        case "function": {
          // 處理函數指令
          try {
            const result = await this.runDynamicFunction(command.id, msg);
            // 如果函數已經處理了回覆，就不需要再執行
            if (result && typeof result === 'string') {
              await this.client.sendMessage(sender, result, {
                quotedMessageId: msg.id._serialized
              });
            }
          } catch (error) {
            console.error("執行函數指令錯誤:", error);
            await this.client.sendMessage(sender, `執行函數時發生錯誤: ${error.message}`, {
              quotedMessageId: msg.id._serialized
            });
          }
          break;
        }
      }
    } catch (error) {
      console.error("執行指令回應錯誤:", error);
      // 確保即使出錯也發送通知
      try {
        await this.client.sendMessage(sender, "執行指令時出錯，請稍後重試或通知管理員。", {
          quotedMessageId: msg.id._serialized
        });
      } catch (e) {
        console.error("發送錯誤通知失敗:", e);
      }
    }
  }

  async saveData(type) {
    const filename = `${type}.json`;
    const data =
      type === "groups"
        ? this.groups
        : type === "contacts"
        ? this.contacts
        : this.activeCommands;

    try {
      await fs.writeFile(
        path.join(this.dataDir, filename),
        JSON.stringify(Array.from(data.entries()), null, 2)
      );
    } catch (error) {
      console.error(`Error saving ${filename}:`, error);
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
      // 包裝成 module.exports = async function(msg, client) { ... }
      const code = `module.exports = async function(msg, client) {\n${commandData.response.content}\n}`;
      await fs.writeFile(funcPath, code, "utf8");
      // 存檔案路徑代替原始內容到 commands.json
      const originalContent = commandData.response.content;
      commandData.response.content = `functions/${commandData.id}.js`;
      commandData.response._contentBackup = originalContent.substring(0, 100) + "..."; // 保存前100個字元作為備份
    }
    // 如果是 video 指令，寫入 data/video/{id}.mp4
    else if (commandData.response && commandData.response.type === "video") {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const videoPath = path.join(videoDir, `${commandData.id}.mp4`);
      // 將 base64 內容寫入檔案
      const base64Data = commandData.response.content.replace(/^data:video\/mp4;base64,/, "");
      await fs.writeFile(videoPath, Buffer.from(base64Data, 'base64'));
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
      commandData.response._contentBackup = originalContent.substring(0, 100) + "..."; // 保存前100個字元作為備份
    }
    // 如果是 video 指令，寫入 data/video/{id}.mp4
    else if (commandData.response && commandData.response.type === "video") {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const videoPath = path.join(videoDir, `${id}.mp4`);
      // 檢查內容是否已經是檔案路徑
      if (!commandData.response.content.startsWith('video/')) {
        // 將 base64 內容寫入檔案
        const base64Data = commandData.response.content.replace(/^data:video\/mp4;base64,/, "");
        await fs.writeFile(videoPath, Buffer.from(base64Data, 'base64'));
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
