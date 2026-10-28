#!/bin/bash
# macOS 一键启动:双击运行(首次需要 chmod +x,见 README)。首次自动建配置、安装依赖。
cd "$(dirname "$0")" || exit 1

pause() { read -n 1 -s -r -p "按任意键退出……"; echo; }

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js,请先安装 Node 18 或更新版本(brew install node,或从 nodejs.org 下载)。"
  pause
  exit 1
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "已生成 config.json:请把 mutagen 改成 \"mutagen\"(已在 PATH 里)或它的完整路径,"
  echo "再按实际情况改会话,保存后重新双击本脚本。"
  open -e config.json
  pause
  exit 0
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
