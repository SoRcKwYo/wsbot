# App.js Workflow

## 1. Initialization Phase (啟動階段)

1.  **Dependency Loading**: When the application starts, it loads all necessary Node.js modules, such as `express`, `whatsapp-web.js`, `socket.io`, `http`, etc.
2.  **Core Component Instantiation**:
    *   An `express` application instance (`app`) is created.
    *   An HTTP server (`server`) is created using the `http` module and the `app`.
    *   `socket.io` is attached to the `server`, with CORS and other transport parameters configured.
    *   An instance of the `WhatsAppBot` class (`bot`) is created. This instance is the core of the entire application, managing all WhatsApp interactions.
3.  **Express Middleware Setup**:
    *   `cors` is configured to allow cross-origin requests.
    *   `express.json()` and `express.urlencoded()` are set up to parse incoming request bodies.
    *   `express.static()` is used to serve static files from the `public` directory (the frontend control panel).
4.  **API Route Definition**:
    *   Multiple API routes are defined, such as `/api/groups`, `/api/contacts`, `/api/commands`, etc., for the frontend to fetch backend data or trigger specific actions.
    *   A `/api/qr` route is defined for the frontend to get the QR code for login.
5.  **Socket.io Connection Handling**:
    *   An `io.on('connection', ...)` event listener is set up to handle WebSocket connections from the frontend control panel.
    *   When the frontend requests a connection via `socket.emit('connect-bot')`, the backend triggers the `bot.initialize()` method.
6.  **`bot.initialize()` Flow**:
    *   **Cleanup**: The `cleanup()` method is called, which may clear old sessions or temporary files.
    *   **Directory Creation**: Ensures that necessary directories like `data`, `auth`, `temp` exist.
    *   **`Client` Instantiation**:
        *   A `whatsapp-web.js` client instance is created using `new Client(...)`.
        *   The authentication strategy is set to `LocalAuth`, which saves session data in the `./auth/session-whatsapp-bot` directory.
        *   `puppeteer` is configured with multiple parameters, including running in headless mode (`headless: true`) and with several `--disable-*` flags to improve stability in a server environment.
    *   **Event Handler Setup (`setupEventHandlers`)**: Binds various event listeners to the `Client` instance, such as `qr`, `ready`, `message`, `disconnected`, etc.
    *   **Initialization Start**: `this.client.initialize()` is called, which starts Puppeteer to open a browser instance and navigate to WhatsApp Web.
    *   **Timeout Handling**: `Promise.race` is used to set a 60-second timeout to prevent the initialization process from getting stuck.

## 2. Runtime Phase (運行階段)

*   **QR Code Generation and Scanning**:
    *   If a login is required, the `client.on('qr')` event is triggered.
    *   The backend receives the QR code data and converts it to a Base64 formatted image using the `qrcode` module.
    *   The QR code image data is sent to the frontend for display via `io.emit('qr', ...)`.
    *   The user scans the QR code with their mobile WhatsApp.
*   **Ready**:
    *   After a successful scan, the `client.on('ready')` event is triggered.
    *   The `bot.isInitialized` flag is set to `true`.
    *   The frontend is notified that the bot is ready via `io.emit('ready', ...)`.
    *   `updateGroups()` is called to fetch and cache the list of all groups.
*   **Message Handling**:
    *   The `client.on('message')` and `client.on('message_create')` events listen for all incoming and outgoing messages.
    *   The `handleMessage(msg)` method is called to process the message.
    *   In this method, the program checks if the message corresponds to a defined command (`activeCommands`), and if so, executes the appropriate response.
*   **API Request Handling**:
    *   The frontend control panel can interact with the backend through the previously defined API routes, for example, to get the group list, send messages, add commands, etc.
*   **Socket.io Real-time Communication**:
    *   The backend pushes important events (like status changes, logs) to the frontend in real-time via Socket.io.
    *   The frontend can also trigger backend actions via Socket.io.

## 3. Shutdown Phase (關閉階段)

*   **Disconnection Handling (`disconnected`)**:
    *   When the WhatsApp connection is lost, the `client.on('disconnected')` event is triggered.
    *   The `handleDisconnect(reason)` method is called, which may attempt to reconnect.
*   **Graceful Shutdown (`destroy`)**:
    *   When the application is shutting down or needs to be restarted, `bot.destroy()` can be called.
    *   This method clears all auto-trigger timers and calls `this.client.destroy()` to gracefully close the Puppeteer browser and the WhatsApp connection, while preserving authentication data for a quick login next time.
