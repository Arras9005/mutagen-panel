#!/bin/bash
# macOS 一键启动:双击运行(首次需要 chmod +x,见 README)。首次自动安装依赖;配置在面板里设置,首次运行会自动建一份空的。
cd "$(dirname "$0")" || exit 1

pause() { read -n 1 -s -r -p "按任意键退出……"; echo; }

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js,请先安装 Node 18 或更新版本(brew install node,或从 nodejs.org 下载)。"
  pause
  exit 1
fi

if [ ! -d node_modules/ssh2 ]; then
  echo "正在安装依赖(首次运行或升级后)……"
  if ! npm install; then
    echo "npm install 失败。"
    pause
    exit 1
  fi
fi

npm start
pause
