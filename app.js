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
        const groupsData = await fs.readFile(groupsPath, "utf8");
        this.groups = new Map(JSON.parse(groupsData));
      }

      // 加載聯絡人數據
      const contactsPath = path.join(this.dataDir, "contacts.json");
      if (await this.fileExists(contactsPath)) {
        const contactsData = await fs.readFile(contactsPath, "utf8");
        this.contacts = new Map(JSON.parse(contactsData));
      }

      // 加載指令數據
      const commandsPath = path.join(this.dataDir, "commands.json");
      if (await this.fileExists(commandsPath)) {
        const commandsData = await fs.readFile(commandsPath, "utf8");
        this.activeCommands = new Map(JSON.parse(commandsData));
      }
    } catch (error) {
      console.error("Error loading data:", error);
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
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: "whatsapp-bot",
        dataPath: this.authDir,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--disable-web-security",
          "--disable-features=site-per-process",
          "--single-process",
          "--no-zygote",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-hang-monitor",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-sync",
          "--metrics-recording-only",
          "--safebrowsing-disable-auto-update",
          "--password-store=basic",
          "--use-mock-keychain",
          "--window-size=1280,720",
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        timeout: 60000,
      },
      qrMaxRetries: 5,
      authTimeoutMs: 60000,
      takeoverTimeoutMs: 60000,
    });

    const functionDir = path.join(__dirname, "data", "functions");
    if (!existsSync(functionDir)) {
      fs.mkdir(functionDir, { recursive: true });
    }

    this.setupEventHandlers();
    return this.client.initialize().catch((error) => {
      console.error("Failed to initialize client:", error);
      this.handleInitializationError(error);
    });
  }

  async handleInitializationError(error) {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      console.log(
        `Retrying initialization (attempt ${this.retryCount}/${this.maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.initialize();
    } else {
      console.error(
        "Max retry attempts reached. Failed to initialize WhatsApp client."
      );
      throw error;
    }
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
  }

  async updateGroups() {
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
      console.error("Error updating groups:", error);
    }
  }

  async handleDisconnect(reason) {
    if (reason !== "user" && this.retryCount < this.maxRetries) {
      console.log("Attempting to reconnect...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.initialize();
    }
  }

  async handleMessage(msg) {
    const messageContent = msg.body;
    const sender = msg.from;
    const chat = await msg.getChat();

    for (const command of this.activeCommands.values()) {
      let shouldTrigger = false;
      for (const trigger of command.triggers) {
        const content = trigger.toLowerCase
          ? messageContent.toLowerCase()
          : messageContent;
        const isReply = msg.hasQuotedMsg || (msg._data && msg._data.quotedMsg);
        if (trigger.isRegex) {
          try {
            const regex = new RegExp(trigger.keyword, trigger.toLowerCase ? 'i' : undefined);
            if (regex.test(content)) {
              if (trigger.quotedMsg) {
                if (isReply) shouldTrigger = true;
              } else {
                shouldTrigger = true;
              }
            }
          } catch (e) {
            // 無效正則不觸發
          }
        } else if (trigger.keyword) {
          const match = trigger.startsWith ? content.startsWith(trigger.keyword) : content.includes(trigger.keyword);
          if (match) {
            if (trigger.quotedMsg) {
              if (isReply) shouldTrigger = true;
            } else {
              shouldTrigger = true;
            }
          }
        } else if (trigger.quotedMsg && !trigger.keyword && !trigger.isRegex) {
          if (isReply) shouldTrigger = true;
        }
        if (shouldTrigger) break;
      }

      if (shouldTrigger) {
        console.log('觸發條件 matched triggers:', JSON.stringify(command.triggers, null, 2));
        const isTargetMatch = command.targets.some((target) => {
          if (chat.isGroup) {
            return target.type === "group" && target.id === chat.id._serialized;
          } else {
            return target.type === "contact" && target.id === sender;
          }
        });

        if (isTargetMatch) {
          await this.sendResponse(msg, command.response, command.id);
        }
      }
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
      return await fn(msg);
    } catch (e) {
      return `執行 function 指令時發生錯誤：${e.message}`;
    }
  }

  async sendResponse(msg, response, commandId) {
    try {
      switch (response.type) {
        case "text":
          await msg.reply(response.content);
          break;
        case "image":
          try {
            let media;
            if (response.content.startsWith("data:")) {
              // base64 data URL
              media = new MessageMedia(
                response.content.split(";")[0].split(":")[1],
                response.content.split(",")[1]
              );
            } else {
              // assume URL
              media = await MessageMedia.fromUrl(response.content);
            }
            await msg.reply(media);
          } catch (mediaError) {
            console.error("Image loading error:", mediaError);
            await msg.reply("Sorry, image content is not available.");
          }
          break;
        case "video":
          try {
            let media;
            if (response.content.startsWith("/data/video/")) {
              const filePath = path.join(__dirname, response.content);
              media = MessageMedia.fromFilePath(filePath);
            } else if (response.content.startsWith("data:")) {
              media = MessageMedia.fromDataUrl(response.content);
            } else {
              media = await MessageMedia.fromUrl(response.content);
            }
            await msg.reply(media);
          } catch (mediaError) {
            console.error("Video loading error:", mediaError);
            await msg.reply("Sorry, video content is not available.");
          }
          break;
        case "function":
          if (commandId) {
            const result = await this.runDynamicFunction(commandId, msg);
            await msg.reply(result);
          } else {
            await msg.reply("找不到 function 指令 id。");
          }
          break;
        default:
          console.warn("Unknown response type:", response.type);
      }
    } catch (error) {
      console.error("Error sending response:", error);
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
    if (this.client) {
      if (this.eventHandlers.has("disconnected")) {
        try {
          await this.eventHandlers.get("disconnected")();
        } catch (error) {
          console.error("Error in destroy event handler:", error);
        }
      }
      await this.client.destroy();
      this.client = null;
      this.isInitialized = false;
      console.log("client destroy done");
    }
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
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));
// 修改靜態文件服務
app.use(express.static(path.join(__dirname, "public")));
app.use('/data/functions', express.static(path.join(__dirname, 'data', 'functions')));
app.use('/data/video', express.static(path.join(__dirname, 'data', 'video')));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Console 功能
let logHistory = [];
const maxLogEntries = 1000;

function addLogEntry(level, message) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message
  };
  
  logHistory.push(entry);
  if (logHistory.length > maxLogEntries) {
    logHistory.shift();
  }
  
  // 通知前端更新日誌
  io.emit('console-log', entry);
}

// 替換原有的 console 方法
['log', 'error', 'warn', 'info'].forEach(level => {
  const originalMethod = console[level];
  console[level] = (...args) => {
    originalMethod.apply(console, args);
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    addLogEntry(level, message);
  };
});

// API 路由
app.get('/api/logs', (req, res) => {
  const { level } = req.query;
  let filteredLogs = logHistory;
  
  if (level && level !== 'all') {
    filteredLogs = logHistory.filter(log => log.level === level);
  }
  
  res.json(filteredLogs);
});

// 清除日誌
app.post('/api/logs/clear', (req, res) => {
  logHistory = [];
  io.emit('logs-cleared');
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
      width: 800,
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
      // 包裝成 module.exports = async function(msg) { ... }
      const code = `module.exports = async function(msg) {\n${commandData.response.content}\n}`;
      await fs.writeFile(funcPath, code, "utf8");
      // 只存原始內容在 commands.json
      commandData.response.content = commandData.response.content;
    }
    // 如果是 video，將 base64 存檔到 /data/video
    if (commandData.response && commandData.response.type === "video" && commandData.response.content.startsWith("data:")) {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const ext = commandData.response.content.substring(11, commandData.response.content.indexOf(";"));
      const fileExt = ext.split("/")[1] || "mp4";
      const fileName = `${commandData.id}.${fileExt}`;
      const filePath = path.join(videoDir, fileName);
      const base64Data = commandData.response.content.split(",")[1];
      await fs.writeFile(filePath, base64Data, "base64");
      commandData.response.content = `/data/video/${fileName}`;
    }
    bot.activeCommands.set(commandData.id, commandData);
    await bot.saveData("commands");
    res.json({ success: true, command: commandData });
  } catch (error) {
    res.status(500).json({ message: "添加指令失敗" });
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
      const code = `module.exports = async function(msg) {\n${commandData.response.content}\n}`;
      await fs.writeFile(funcPath, code, "utf8");
      commandData.response.content = commandData.response.content;
    }
    if (commandData.response && commandData.response.type === "video" && commandData.response.content.startsWith("data:")) {
      const videoDir = path.join(__dirname, "data", "video");
      if (!existsSync(videoDir)) {
        await fs.mkdir(videoDir, { recursive: true });
      }
      const ext = commandData.response.content.substring(11, commandData.response.content.indexOf(";"));
      const fileExt = ext.split("/")[1] || "mp4";
      const fileName = `${id}.${fileExt}`;
      const filePath = path.join(videoDir, fileName);
      const base64Data = commandData.response.content.split(",")[1];
      await fs.writeFile(filePath, base64Data, "base64");
      commandData.response.content = `/data/video/${fileName}`;
    }
    bot.activeCommands.set(id, commandData);
    await bot.saveData("commands");
    res.json({ success: true, command: commandData });
  } catch (error) {
    res.status(500).json({ message: "更新指令失敗" });
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
    if (!/^npm\s+(i|install)\s+[a-zA-Z0-9@\-_/]+(\s+[a-zA-Z0-9@\-_/]+)*$/.test(command.trim())) {
      return res.json({ error: "只允許執行 npm install 指令，且不能包含特殊符號。" });
    }
    command = "sudo " + command; // 加上 sudo
    exec(command, { cwd: process.cwd(), timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        return res.json({ error: stderr || err.message });
      }
      res.json({ output: stdout || stderr || "(無輸出)" });
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// 新增 /api/update-html 路由
app.post('/api/update-html', async (req, res) => {
  const { exec } = require('child_process');
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  const url = 'https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/public/index.html';
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
