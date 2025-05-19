const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qr = require("qrcode");
const socketIo = require("socket.io");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const fsSync = require("fs"); // 添加同步版 fs
const path = require("path");
const existsSync = require("fs").existsSync;
const rimraf = require("rimraf").sync; // 用於清除目錄
const { exec } = require("child_process");

const CONFIG = {
  port: process.env.PORT || 3333,
  paths: {
    data: process.env.DATA_DIR || path.join(__dirname, "data"),
    auth: process.env.AUTH_DIR || path.join(__dirname, "auth"),
    temp: process.env.TEMP_DIR || path.join(__dirname, "temp"),
  },
  github: {
    repo: "SoRcKwYo/wsbot",
    branch: "main",
  },
  timeouts: {
    initialization: 60000,
    shutdown: 5000,
    cleanup: 3600000,
  },
  bot: {
    maxRetries: 3,
    reconnectDelay: 5000,
  },
  security: {
    allowedCommands: ["npm", "install", "i"],
  },
  delays: {
    preInit: 2000, // 初始化前延遲
    postCleanup: 3000, // 清理後延遲
    reconnect: 1000, // 重連前延遲
  },
};

// 添加通用錯誤處理工具函數
function handleApiError(res, error, operation = "操作") {
  console.error(`${operation}失敗:`, error);
  res.status(500).json({ message: `${operation}失敗: ${error.message}` });
  return false;
}

function handleEventError(eventName, error) {
  console.error(`${eventName}事件處理錯誤:`, error);
  return false;
}

function handleOperationError(operation, error) {
  console.error(`${operation}錯誤:`, error);
  return false;
}

class WhatsAppBot {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.groups = new Map();
    this.contacts = new Map();
    this.activeCommands = new Map();
    this.eventHandlers = new Map();
    this.dataDir = CONFIG.paths.data;
    this.authDir = CONFIG.paths.auth;
    this.tempDir = CONFIG.paths.temp;
    this.sessionDir = path.join(this.authDir, "session-whatsapp-bot");
    this.isShuttingDown = false;
    this.browser = null;
    this.retryCount = 0;
    this.maxRetries = CONFIG.bot.maxRetries;
    // 增加定期清理
    this.cleanupInterval = setInterval(() => {
      this.cleanupTempFiles().catch((error) =>
        console.error("自動清理臨時檔案失敗:", error)
      );
    }, CONFIG.timeouts.cleanup); // 每小時清理

    // 新增自動觸發定時器集合
    this.autoTriggerTimers = new Map();
  }

  // 新增初始化自動觸發功能的方法
  initAutoTriggers() {
    // 清除所有現有的自動觸發定時器
    for (const timer of this.autoTriggerTimers.values()) {
      clearInterval(timer);
    }
    this.autoTriggerTimers.clear();

    // 檢查每個指令是否有自動觸發條件
    for (const command of this.activeCommands.values()) {
      if (command.enabled === false) continue;
      for (const trigger of command.triggers || []) {
        if (trigger.autoTrigger && trigger.autoInterval) {
          const { hours = 0, minutes = 0, seconds = 0 } = trigger.autoInterval;
          const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

          if (totalMs <= 0) continue; // 跳過無效的時間設定

          console.log(
            `為指令 '${
              command.name || command.id
            }' 設定自動觸發: ${hours}小時 ${minutes}分鐘 ${seconds}秒`
          );

          // 為每個目標設定自動觸發
          for (const target of command.targets) {
            const timerId = setInterval(async () => {
              try {
                if (!this.isInitialized || this.isShuttingDown) return;

                const chatId = target.id;
                console.log(
                  `執行自動觸發指令: ${command.name || command.id} 至 ${chatId}`
                );

                // 創建模擬消息對象，用於處理自動觸發
                const simulatedMsg = {
                  type: "autoTrigger",
                  from: this.client?.info?.wid?._serialized || "system",
                  to: chatId,
                  id: {
                    _serialized: `auto_${Date.now()}_${Math.random()
                      .toString(36)
                      .substring(2, 10)}`,
                    fromMe: true,
                    remote: chatId,
                  },
                  reply: async (content) => {
                    try {
                      await this.client.sendMessage(chatId, content);
                      return true;
                    } catch (err) {
                      console.error("自動觸發回覆失敗:", err);
                      return false;
                    }
                  },
                  getChat: async () => {
                    try {
                      return await this.client.getChatById(chatId);
                    } catch (error) {
                      console.error("獲取聊天失敗:", error);
                      return {
                        id: { _serialized: chatId },
                        isGroup: chatId.includes("@g.us"),
                      };
                    }
                  },
                };

                // 執行指令回應
                await this.sendResponse(command, simulatedMsg);
              } catch (error) {
                console.error("自動觸發執行失敗:", error);
              }
            }, totalMs);

            // 儲存定時器ID，以便將來清理
            const timerKey = `${command.id}_${target.id}`;
            this.autoTriggerTimers.set(timerKey, timerId);
          }
        }
      }
    }

    console.log(`已設定 ${this.autoTriggerTimers.size} 個自動觸發定時器`);
  }

  async reconnect() {
    try {
      await this.destroy();
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delays.reconnect)
      );
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
        if (now - stats.mtime.getTime() > CONFIG.timeouts.cleanup) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      return handleOperationError("清理臨時檔案", error);
    }
  }

  startCleanupSchedule() {
    setInterval(() => this.cleanupTempFiles(), CONFIG.timeouts.cleanup);
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

        // 加載完指令後初始化自動觸發功能
        if (this.isInitialized) {
          this.initAutoTriggers();
        }
      }
    } catch (error) {
      return handleOperationError("加載數據", error);
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
      return handleOperationError(`保存 ${type} 數據`, error);
    }
  }

  async initialize() {
    try {
      await this.cleanup();
      await this.ensureDirectories();

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: "whatsapp-bot",
          dataPath: this.sessionDir,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-extensions",
            "--disable-default-apps",
            "--disable-popup-blocking",
            "--disable-notifications",
            "--window-size=1280,720",
          ],
          ignoreHTTPSErrors: true,
          defaultViewport: null,
          timeout: 120000,
        },
      });

      const functionDir = path.join(__dirname, "data", "functions");
      if (!existsSync(functionDir)) {
        fs.mkdir(functionDir, { recursive: true });
      }

      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delays.preInit)
      );

      this.setupEventHandlers();
      console.log("開始初始化 WhatsApp 客戶端...");

      const initPromise = this.client.initialize();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("初始化超時")),
          CONFIG.timeouts.initialization
        );
      });

      await Promise.race([initPromise, timeoutPromise]);

      this.isInitialized = true;
      this.retryCount = 0;
      console.log("WhatsApp 客戶端初始化成功");
      return true;
    } catch (error) {
      return this.handleInitializationError(error);
    }
  }

  async cleanup() {
    try {
      if (this.client) {
        try {
          await this.client.destroy();
          this.client = null;
        } catch (e) {
          console.warn("關閉現有客戶端警告:", e);
        }
      }

      // 清理鎖定檔案
      const lockFile = path.join(this.sessionDir, "SingletonLock");
      if (existsSync(lockFile)) {
        try {
          await fs.unlink(lockFile);
          console.log("已清理鎖定檔案");
        } catch (error) {
          console.warn("清理鎖定檔案警告:", error);
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delays.postCleanup)
      );
    } catch (error) {
      console.error("清理過程出錯:", error);
    }
  }

  async handleInitializationError(error) {
    console.error(handleOperationError("初始化", error));

    // 確保完整清理
    await this.cleanup();

    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      console.log(`嘗試重新初始化 (${this.retryCount}/${this.maxRetries})`);

      // 使用指數退避策略
      const delay = Math.min(1000 * Math.pow(2, this.retryCount), 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return this.initialize();
    }

    throw new Error("超過最大重試次數，初始化失敗");
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

    this.client.on("qr", async (qrData) => {
      try {
        console.log("收到 QR Code 數據");
        if (qrData) {
          // 生成 base64 QR code
          const qrImageData = await qr.toDataURL(qrData, {
            margin: 2,
            scale: 10,
          });
          currentQrCode = qrImageData;

          // 先發送載入狀態為 false
          io.emit("qr-loading", false);

          // 確保 QR 碼發送到前端，並增加重試機制
          const emitQR = (attempts = 0) => {
            io.emit("qr", qrImageData);
            console.log(`QR Code 已發送到前端 (嘗試 ${attempts + 1})`);

            // 如果尚未成功連接，5秒後重發 QR 碼
            if (attempts < 3 && !bot.client?.info) {
              setTimeout(() => emitQR(attempts + 1), 10000);
            }
          };

          emitQR();
        }
      } catch (error) {
        console.error("QR Code 處理失敗:", error);
        io.emit("qr-loading", false);
      }
    });

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

    this.client.on("ready", async () => {
      try {
        this.isInitialized = true;
        this.retryCount = 0;
        if (this.eventHandlers.has("ready")) {
          await this.eventHandlers.get("ready")();
        }
        console.log("Client is ready to receive messages.");
        await this.updateGroups();

        // WhatsApp 連接成功後初始化自動觸發功能
        this.initAutoTriggers();
      } catch (error) {
        return handleEventError("ready", error);
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
        return handleEventError("disconnected", error);
      }
    });

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
        return handleOperationError("更新群組", error);
      }
    }
  }

  // 處理表情反應
  async handleReaction(reaction) {
    if (this.isShuttingDown || !reaction) return;
    try {
      // 添加必要欄位檢查
      if (!reaction.msgId || !reaction.reaction) {
        console.log("表情反應缺少必要資訊，無法處理");
        return;
      }
      console.log("收到表情反應原始資料:", JSON.stringify(reaction, null, 2));

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
      return handleOperationError("處理表情反應", error);
    }
  }

  // 處理消息
  async handleMessage(msg) {
    if (this.isShuttingDown) return;

    // 特殊處理：忽略系統自身發送的幫助信息
    if (
      msg.fromMe &&
      (msg.body.startsWith("*Command List*") || msg._data.isForwarded)
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
      const hasQuotedMsg =
        !isReaction &&
        (data.hasQuotedMsg || (data._data && data._data.quotedMsg));

      // 收集匹配的指令
      const matchedCommands = [];

      // 檢查每個指令
      for (const command of this.activeCommands.values()) {
        if (command.enabled === false) continue;

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
            const isReply = hasQuotedMsg;
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

            if (data.type === "autoTrigger" && trigger.autoTrigger) {
              shouldTrigger = true;
              // 自動觸發消息直接匹配，無需進一步檢查關鍵詞
              continue;
            }

            // 正則表達式觸發條件
            if (trigger.isRegex) {
              try {
                const regex = new RegExp(
                  trigger.keyword,
                  trigger.toLowerCase ? "i" : undefined
                );
                if (regex.test(content)) {
                  // 增強引用消息處理
                  if (trigger.quotedMsg && isReply) {
                    // 如果需要檢查引用消息的內容，可以在這裡獲取
                    if (trigger.quotedMsgContains) {
                      const quotedMsg = await data.getQuotedMessage();
                      const quotedMsgText = quotedMsg.body;

                      // 檢查引用消息是否包含指定內容
                      if (!quotedMsgText.includes(trigger.quotedMsgContains)) {
                        continue; // 不匹配，跳過
                      }
                    }
                    shouldTrigger = true;
                  } else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
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
                // 增強引用消息處理
                if (trigger.quotedMsg && isReply) {
                  // 類似上面的引用消息內容檢查
                  if (trigger.quotedMsgContains) {
                    const quotedMsg = await data.getQuotedMessage();
                    const quotedMsgText = quotedMsg.body;

                    // 檢查引用消息是否包含指定內容
                    if (!quotedMsgText.includes(trigger.quotedMsgContains)) {
                      continue; // 不匹配，跳過
                    }
                  }
                  shouldTrigger = true;
                } else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
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
              if (trigger.quotedMsg && isReply) {
                // 類似上面的引用消息內容檢查
                if (trigger.quotedMsgContains) {
                  const quotedMsg = await data.getQuotedMessage();
                  const quotedMsgText = quotedMsg.body;

                  // 檢查引用消息是否包含指定內容
                  if (!quotedMsgText.includes(trigger.quotedMsgContains)) {
                    continue; // 不匹配，跳過
                  }
                }
                shouldTrigger = true;
              } else if (trigger.hasMedia && hasMedia) shouldTrigger = true;
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
      return handleOperationError("處理消息或表情反應", error);
    }
  }

  async handleDisconnect(reason) {
    try {
      // 只有在非用戶主動退出時才嘗試重新連接
      if (reason !== "user" && this.retryCount < this.maxRetries) {
        console.log("Attempting to reconnect...");
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.timeouts.shutdown)
        );
        await this.initialize();
      }
    } catch (error) {
      return handleOperationError("重新連接", error);
    }
  }

  async runDynamicFunction(id, msg) {
    const funcPath = path.join(this.dataDir, "functions", `${id}.js`);
    if (!existsSync(funcPath)) {
      return "找不到對應的 function 指令檔案。";
    }

    try {
      // 檢查檔案是否已修改
      const stats = await fs.stat(funcPath);
      const lastModified = stats.mtime.getTime();

      // 只在必要時刷新緩存
      if (
        !this.functionCache[id] ||
        this.functionCache[id].lastModified < lastModified
      ) {
        delete require.cache[require.resolve(funcPath)];
        this.functionCache[id] = {
          fn: require(funcPath),
          lastModified: lastModified,
        };
      }

      if (typeof this.functionCache[id].fn !== "function") {
        return "function 檔案未正確導出函式。";
      }

      return await this.functionCache[id].fn(msg, this.client);
    } catch (e) {
      return handleOperationError("執行動態函數", e);
    }
  }

  async sendResponse(command, msg) {
    const sender = msg.fromMe ? msg.to : msg.from;
    const chat = await msg.getChat();
    const isReaction = msg.type === "reaction"; // 檢查是否為表情反應
    const isAutoTrigger = msg.type === "autoTrigger"; // 檢查是否為自動觸發消息

    try {
      switch (command.response.type) {
        case "text":
          // 直接回覆文字訊息，表情反應不使用 quotedMessageId
          await this.client.sendMessage(
            sender,
            command.response.content,
            isReaction || isAutoTrigger
              ? {}
              : { quotedMessageId: msg.id._serialized }
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
            await this.client.sendMessage(
              sender,
              media,
              isReaction || isAutoTrigger
                ? {}
                : { quotedMessageId: msg.id._serialized }
            );
            console.log("圖片發送成功");
          } catch (error) {
            console.error("圖片發送失敗:", error);
            await this.client.sendMessage(
              sender,
              "圖片發送失敗，請再試一次。",
              isReaction || isAutoTrigger
                ? {}
                : { quotedMessageId: msg.id._serialized }
            );
          }
          break;
        }
        case "video": {
          // 處理影片，表情反應或自動觸發不使用 quotedMessageId
          try {
            const videoPath = path.join(this.dataDir, command.response.content);
            const media = MessageMedia.fromFilePath(videoPath);
            await this.client.sendMessage(
              sender,
              media,
              isReaction || isAutoTrigger
                ? {}
                : { quotedMessageId: msg.id._serialized }
            );
            console.log("影片發送成功");
          } catch (error) {
            console.error("影片發送流程錯誤:", error);
            await this.client.sendMessage(
              sender,
              "影片發送失敗，請再試一次或通知管理員檢查影片檔案大小。",
              isReaction || isAutoTrigger
                ? {}
                : { quotedMessageId: msg.id._serialized }
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
              await this.client.sendMessage(
                sender,
                result,
                isReaction || isAutoTrigger
                  ? {}
                  : { quotedMessageId: msg.id._serialized }
              );
            }
          } catch (error) {
            console.error("執行函數指令錯誤:", error);
            await this.client.sendMessage(
              sender,
              `執行函數時發生錯誤: ${error.message}`,
              isReaction || isAutoTrigger
                ? {}
                : { quotedMessageId: msg.id._serialized }
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
          isReaction || isAutoTrigger
            ? {}
            : { quotedMessageId: msg.id._serialized }
        );
      } catch (e) {
        console.error("發送錯誤通知失敗:", e);
      }
    }
  }

  async searchGroup(name) {
    if (!this.isInitialized) {
      return handleOperationError(
        "搜尋群組",
        new Error("WhatsApp client not initialized")
      );
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

    // 清理所有自動觸發定時器
    for (const timer of this.autoTriggerTimers.values()) {
      clearInterval(timer);
    }
    this.autoTriggerTimers.clear();

    if (this.client) {
      if (this.eventHandlers.has("disconnected")) {
        try {
          await this.eventHandlers.get("disconnected")();
        } catch (error) {
          console.error("Error in destroy event handler:", error);
        }
      }

      // 清理定時器
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      await this.cleanupTempFiles().catch(console.error);
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
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
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
let currentQrCode = null;
let logHistory = [];
const maxLogEntries = 1000;

// 當前版本號，可以存在某個配置文件或環境變量中
const currentVersion = "1.0.0";

// Github 相關資訊
const githubRepo = "SoRcKwYo/wsbot"; // 根據您的GitHub用戶名和倉庫名修改
const githubBranch = "main"; // 您的主要分支名稱

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

app.get("/health/detailed", (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    uptime: process.uptime(),
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
    },
    stats: {
      commands: bot.activeCommands.size,
      groups: bot.groups.size,
    },
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: currentVersion });
});

// 檢查是否有新版本的API
app.get("/api/check-update", async (req, res) => {
  try {
    // 從 GitHub 獲取最新的 index.html 文件時間戳
    const response = await fetch(
      `https://api.github.com/repos/${githubRepo}/commits?path=public/index.html&sha=${githubBranch}&per_page=1`
    );

    if (!response.ok) {
      throw new Error(`GitHub API 請求失敗: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return res.json({ hasUpdate: false });
    }

    const latestCommit = data[0];
    const latestCommitDate = new Date(latestCommit.commit.committer.date);

    // 獲取本地文件的修改時間
    const localFilePath = path.join(__dirname, "public", "index.html");
    const stats = await fs.stat(localFilePath);
    const localFileDate = new Date(stats.mtime);

    // 比較時間戳
    const hasUpdate = latestCommitDate > localFileDate;

    res.json({
      hasUpdate,
      localVersion: localFileDate.toISOString(),
      remoteVersion: latestCommitDate.toISOString(),
      latestCommitSha: latestCommit.sha.slice(0, 7), // 短 SHA 作為版本標識
    });
  } catch (error) {
    return handleApiError(res, error, "檢查更新");
  }
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
    console.log("收到 QR Code 數據");
    if (qrData) {
      // 生成 base64 QR code
      const qrImageData = await qr.toDataURL(qrData, { margin: 2, scale: 10 });
      currentQrCode = qrImageData;

      // 先發送載入狀態為 false
      io.emit("qr-loading", false);

      // 確保 QR 碼發送到前端，並增加重試機制
      const emitQR = (attempts = 0) => {
        io.emit("qr", qrImageData);
        console.log(`QR Code 已發送到前端 (嘗試 ${attempts + 1})`);

        // 如果尚未成功連接，5秒後重發 QR 碼
        if (attempts < 3 && !bot.client?.info) {
          setTimeout(() => emitQR(attempts + 1), CONFIG.timeouts.shutdown);
        }
      };

      emitQR();
    }
  } catch (error) {
    console.error("QR Code 處理失敗:", error);
    io.emit("qr-loading", false);
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

app.get("/api/qr", (req, res) => {
  if (currentQrCode) {
    res.json({ qrcode: currentQrCode });
  } else {
    res.status(404).json({ error: "QR code not available" });
  }
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
    return handleApiError(res, error, "添加指令");
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
    return handleApiError(res, error, "更新指令");
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
    return handleApiError(res, error, "添加聯絡人");
  }
});

app.post("/api/commands", async (req, res) => {
  try {
    const commandData = req.body;
    commandData.id = Date.now().toString();

    // 確保新指令預設為啟用狀態
    if (commandData.enabled === undefined) {
      commandData.enabled = true;
    }

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
    // 檢查並初始化自動觸發
    if (bot.isInitialized) {
      bot.initAutoTriggers();
    }

    res.json({ success: true, command: commandData });
  } catch (error) {
    return handleApiError(res, error, "添加指令");
  }
});

app.put("/api/commands/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const commandData = req.body;
    commandData.id = id;

    // 獲取現有指令
    const existingCommand = bot.activeCommands.get(id);
    if (!existingCommand) {
      return res.status(404).json({ message: "Command not found" });
    }

    // 如果請求中未提供 enabled 屬性，保留原有的設定
    if (commandData.enabled === undefined) {
      commandData.enabled = existingCommand.enabled;
    }

    // 如果是 function 指令，寫入 data/functions/{id}.js
    if (commandData.response && commandData.response.type === "function") {
      const funcDir = path.join(__dirname, "data", "functions");
      if (!existsSync(funcDir)) {
        await fs.mkdir(funcDir, { recursive: true });
      }
      const funcPath = path.join(funcDir, `${id}.js`);

      // 檢查內容是否已經包含 module.exports
      let code = commandData.response.content;
      if (!code.includes("module.exports")) {
        // 包裝成 module.exports = async function(msg, client) { ... }
        code = `module.exports = async function(msg, client) {\n${code}\n}`;
      }
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

    // 檢查並更新自動觸發
    if (bot.isInitialized) {
      bot.initAutoTriggers();
    }

    res.json({ success: true, command: commandData });
  } catch (error) {
    return handleApiError(res, error, "更新指令");
  }
});

app.delete("/api/groups/:id", async (req, res) => {
  try {
    bot.groups.delete(req.params.id);
    await bot.saveData("groups");
    res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error, "刪除群組");
  }
});

app.delete("/api/contacts/:id", async (req, res) => {
  try {
    bot.contacts.delete(req.params.id);
    await bot.saveData("contacts");
    res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error, "刪除聯絡人");
  }
});

app.delete("/api/commands/:id", async (req, res) => {
  try {
    // 刪除相關自動觸發定時器
    const commandId = req.params.id;
    for (const [timerKey, timer] of bot.autoTriggerTimers.entries()) {
      if (timerKey.startsWith(`${commandId}_`)) {
        clearInterval(timer);
        bot.autoTriggerTimers.delete(timerKey);
      }
    }

    bot.activeCommands.delete(commandId);
    await bot.saveData("commands");
    res.json({ success: true });
  } catch (error) {
    return handleApiError(res, error, "刪除指令");
  }
});

// Terminal API：僅允許 npm install 指令
app.post("/api/terminal", async (req, res) => {
  try {
    let { command } = req.body;
    // 使用CONFIG中的白名單檢查
    const isAllowedCommand = CONFIG.security.allowedCommands.some(
      (cmd) =>
        command.trim().startsWith(`npm ${cmd}`) ||
        command.trim() === `npm ${cmd}`
    );

    if (!isAllowedCommand) {
      return res.json({
        error: "只允許執行 npm install 指令，且不能包含特殊符號。",
      });
    }
    // 避免 command 被重新賦值
    const safeCommand = "sudo " + command.trim();

    exec(
      safeCommand,
      {
        cwd: process.cwd(),
        timeout: 120000,
        // 增加環境變數限制
        env: {
          ...process.env,
          PATH: process.env.PATH,
        },
      },
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

// 修改 /api/update-html 路由
app.post("/api/update-html", async (req, res) => {
  const { exec } = require("child_process");
  const baseDir = path.join(__dirname, "public");
  const githubBase =
    "https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/public";

  try {
    // 創建下載多個文件的 Promise 陣列
    const downloads = [
      // 下載 index.html
      new Promise((resolve, reject) => {
        exec(
          `curl -o "${path.join(
            baseDir,
            "index.html"
          )}" "${githubBase}/index.html"`,
          (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve("index.html 已更新");
          }
        );
      }),

      // 下載 sw.js
      new Promise((resolve, reject) => {
        exec(
          `curl -o "${path.join(baseDir, "sw.js")}" "${githubBase}/sw.js"`,
          (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve("sw.js 已更新");
          }
        );
      }),

      // 下載 manifest.json
      new Promise((resolve, reject) => {
        exec(
          `curl -o "${path.join(
            baseDir,
            "manifest.json"
          )}" "${githubBase}/manifest.json"`,
          (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve("manifest.json 已更新");
          }
        );
      }),
    ];

    // 執行所有下載任務
    const results = await Promise.allSettled(downloads);

    // 檢查結果
    const successful = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);

    res.json({
      success: failed.length === 0,
      updated: successful,
      failed: failed.length > 0 ? failed : null,
    });
  } catch (error) {
    return handleApiError(res, error, "更新指令");
  }
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("error", (error) => {
    console.error("Socket error:", error);
    socket.emit("error", "連接出錯，請重試");
  });

  socket.on("connect_error", (error) => {
    console.error("Connection error:", error);
    io.emit("qr-loading", false);
  });

  socket.on("connect-bot", async () => {
    console.log("收到連接請求");

    try {
      io.emit("qr-loading", true);

      if (!bot.isInitialized) {
        console.log("開始初始化 Bot...");
        // 清理現有狀態
        if (bot.client) {
          try {
            await bot.destroy();
            await new Promise((resolve) =>
              setTimeout(resolve, CONFIG.delays.reconnect)
            );
          } catch (error) {
            console.warn("清理現有客戶端警告:", error);
          }
        }

        // 添加專門的 QR code 監聽器
        let qrReceived = false;
        const qrListener = (qr) => {
          qrReceived = true;
          console.log("QR code 已生成並發送");
        };
        bot.on("qr", qrListener);

        await bot.initialize();

        // 等待 QR code 生成或已連接
        let attempts = 0;
        while (!qrReceived && !bot.client?.info && attempts < 30) {
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.delays.reconnect)
          );
          attempts++;
        }

        if (bot.client?.info) {
          console.log("Bot 已連接且初始化成功");
          io.emit("ready", "WhatsApp is ready!");
        } else if (qrReceived) {
          console.log("QR code 已準備好掃描");
        } else {
          throw new Error("QR code 生成超時");
        }
      } else {
        console.log("Bot 已經初始化");
        socket.emit("ready");
      }
    } catch (error) {
      handleEventError("connect-bot", error);
      socket.emit("error", `初始化失敗: ${error.message}`);
      io.emit("qr-loading", false);

      // 確保清理
      try {
        await bot.cleanup();
      } catch (cleanupError) {
        console.error("清理失敗:", cleanupError);
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
  });

  // 發送初始數據
  socket.emit("updateData", {
    groups: Array.from(bot.groups.values()),
    contacts: Array.from(bot.contacts.values()),
    commands: Array.from(bot.activeCommands.values()),
    botStatus: {
      initialized: bot.isInitialized,
      timestamp: new Date().toISOString(),
    },
  });
});

// 新增 API 端點以切換指令的啟用/停用狀態
app.patch("/api/commands/:id/enabled", async (req, res) => {
  try {
    const commandId = req.params.id;
    const { enabled } = req.body;

    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ message: "Invalid 'enabled' value. Must be true or false." });
    }

    const command = bot.activeCommands.get(commandId);
    if (!command) {
      return res.status(404).json({ message: "Command not found" });
    }

    // 更新指令的啟用狀態
    command.enabled = enabled;
    bot.activeCommands.set(commandId, command);
    await bot.saveData("commands");

    // 如果指令包含自動觸發，需要更新相關定時器
    if (bot.isInitialized) {
      bot.initAutoTriggers();
    }

    // 通知前端更新
    io.emit("updateCommands", Array.from(bot.activeCommands.values()));

    res.json({ success: true, command });
  } catch (error) {
    return handleApiError(res, error, "更新指令");
  }
});

// 全局未捕獲異常處理
process.on("uncaughtException", (error) => {
  console.error("未捕獲的異常:", error);
  // 不立即結束進程，而是嘗試恢復
  if (bot && typeof bot.reconnect === "function") {
    bot.reconnect().catch(console.error);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("未處理的 Promise 拒絕:", reason);
});

// 優化關閉處理
process.on("SIGINT", async () => {
  console.log("收到關閉信號，正在優雅退出...");
  try {
    if (bot) {
      bot.isShuttingDown = true;
      await bot.destroy();
    }
    server.close(() => {
      console.log("伺服器已關閉");
      process.exit(0);
    });

    // 設置超時強制退出
    setTimeout(() => {
      console.log("強制退出");
      process.exit(1);
    }, CONFIG.timeouts.shutdown);
  } catch (error) {
    console.error("關閉時發生錯誤:", error);
    process.exit(1);
  }
});

// Start server
const startServer = async () => {
  await bot.loadData();

  const PORT = process.env.PORT || CONFIG.port;
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer();
