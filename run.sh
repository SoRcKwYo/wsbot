#!/bin/bash

# 設定編碼
export LANG=zh_TW.UTF-8

# 檢查 Node.js 是否已安裝
if command -v node >/dev/null 2>&1; then
    echo "Node.js 已經安裝，版本："
    node -v
else
    echo "正在安裝 Node.js..."
    
    # 根據作業系統安裝 Node.js
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew >/dev/null 2>&1; then
            brew install node
        else
            echo "請先安裝 Homebrew，然後重新執行此腳本"
            echo "安裝指令：/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            exit 1
        fi
    else
        # Linux
        if command -v apt-get >/dev/null 2>&1; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y nodejs
        else
            echo "無法自動安裝 Node.js，請手動安裝後重新執行此腳本"
            exit 1
        fi
    fi
fi

# 驗證安裝
echo "驗證 Node.js 安裝..."
if ! node -v >/dev/null 2>&1; then
    echo "Node.js 未正確安裝"
    echo "請重新啟動電腦後再試一次"
    exit 1
fi

# 下載檔案
echo "下載檔案中..."
if [ ! -f "app.js" ]; then
    echo "下載 app.js..."
    curl -O https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/app.js
    echo "下載 package.json..."
    curl -O https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/package.json
fi

# 下載 HTML 檔案
mkdir -p public
echo "下載 index.html..."
curl -o public/index.html https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/public/index.html

# 檢查並安裝套件
echo "驗證 npm 套件..."
if [ ! -d "node_modules" ]; then
    echo "安裝套件中..."
    npm install
    if [ $? -ne 0 ]; then
        echo "套件安裝失敗"
        exit 1
    fi
    echo "套件安裝成功"
fi

# 啟動應用程式
echo "啟動應用程式..."
npm start &

# 等待伺服器就緒
echo "等待伺服器啟動..."
while ! curl -s http://localhost:3333 >/dev/null; do
    sleep 2
    echo "等待伺服器啟動中..."
done

echo "伺服器已就緒！"
echo "開啟瀏覽器..."

# 根據作業系統開啟瀏覽器
if [[ "$OSTYPE" == "darwin"* ]]; then
    open http://localhost:3333
else
    xdg-open http://localhost:3333
fi