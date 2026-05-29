#!/usr/bin/env node
// Emoji 迁移脚本 - 将 HTML/JavaScript 文件中的 Emoji 替换为 blm-icon 组件
// 使用方法: node scripts/migrate-emojis.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Emoji 替换映射表
const EMOJI_REPLACEMENTS = {
  // 核心功能
  '🧠': '<blm-icon name="brain"></blm-icon>',
  '💭': '<blm-icon name="message-square"></blm-icon>',
  '📝': '<blm-icon name="file-text"></blm-icon>',
  '⚙️': '<blm-icon name="settings"></blm-icon>',
  '⚙': '<blm-icon name="settings"></blm-icon>',
  '🔊': '<blm-icon name="volume"></blm-icon>',
  '🔍': '<blm-icon name="search"></blm-icon>',
  '📊': '<blm-icon name="bar-chart-3"></blm-icon>',
  '🔗': '<blm-icon name="link"></blm-icon>',
  '⏱️': '<blm-icon name="clock"></blm-icon>',
  '🎯': '<blm-icon name="target"></blm-icon>',
  '🔥': '<blm-icon name="flame"></blm-icon>',
  '📡': '<blm-icon name="radio"></blm-icon>',
  '🎤': '<blm-icon name="mic"></blm-icon>',
  '♪': '<blm-icon name="music"></blm-icon>',
  '🎵': '<blm-icon name="music"></blm-icon>',
  '🎶': '<blm-icon name="music"></blm-icon>',

  // 状态图标
  '✅': '<blm-icon name="check-circle-2"></blm-icon>',
  '❌': '<blm-icon name="x-circle"></blm-icon>',
  '⚠️': '<blm-icon name="alert-triangle"></blm-icon>',
  '⚠': '<blm-icon name="alert-triangle"></blm-icon>',
  '🔄': '<blm-icon name="refresh-cw"></blm-icon>',
  '⏳': '<blm-icon name="loader-2"></blm-icon>',
  '💤': '<blm-icon name="moon"></blm-icon>',
  '⚡': '<blm-icon name="zap"></blm-icon>',
  '✓': '<blm-icon name="check"></blm-icon>',
  '✗': '<blm-icon name="x-circle"></blm-icon>',

  // 操作按钮
  '➕': '<blm-icon name="plus"></blm-icon>',
  '➖': '<blm-icon name="minus"></blm-icon>',
  '✏️': '<blm-icon name="pencil"></blm-icon>',
  '🗑️': '<blm-icon name="trash-2"></blm-icon>',
  '📋': '<blm-icon name="clipboard"></blm-icon>',
  '📤': '<blm-icon name="send"></blm-icon>',
  '📥': '<blm-icon name="download"></blm-icon>',
  '🖊️': '<blm-icon name="pencil"></blm-icon>',
  '✒️': '<blm-icon name="pencil"></blm-icon>',

  // 额外图标
  '🌐': '<blm-icon name="globe"></blm-icon>',
  '💬': '<blm-icon name="message-circle"></blm-icon>',
  '📱': '<blm-icon name="smartphone"></blm-icon>',
  '📧': '<blm-icon name="mail"></blm-icon>',
  '🔔': '<blm-icon name="bell"></blm-icon>',
  '🌟': '<blm-icon name="star"></blm-icon>',
  '💫': '<blm-icon name="sparkles"></blm-icon>',
  '✨': '<blm-icon name="sparkles"></blm-icon>',
  '🎬': '<blm-icon name="video"></blm-icon>',
  '🎥': '<blm-icon name="video"></blm-icon>',
  '📄': '<blm-icon name="file-text"></blm-icon>',
  '📁': '<blm-icon name="folder"></blm-icon>',
  '📂': '<blm-icon name="folder-open"></blm-icon>',
  '📌': '<blm-icon name="pin"></blm-icon>',
  '📦': '<blm-icon name="package"></blm-icon>',
  '📍': '<blm-icon name="map-pin"></blm-icon>',
  '🗺️': '<blm-icon name="map"></blm-icon>',
  '🔐': '<blm-icon name="lock"></blm-icon>',
  '🔓': '<blm-icon name="unlock"></blm-icon>',
  '🔑': '<blm-icon name="key"></blm-icon>',
  '🛠️': '<blm-icon name="wrench"></blm-icon>',
  '🔧': '<blm-icon name="wrench"></blm-icon>',
  '🧰': '<blm-icon name="wrench"></blm-icon>',
  '🩺': '<blm-icon name="stethoscope"></blm-icon>',
  '💊': '<blm-icon name="pill"></blm-icon>',
  '🩹': '<blm-icon name="bandage"></blm-icon>',
  '🧪': '<blm-icon name="flask-conical"></blm-icon>',
  '🧬': '<blm-icon name="dna"></blm-icon>',
  '🧠': '<blm-icon name="brain"></blm-icon>',
  '👁️': '<blm-icon name="eye"></blm-icon>',
  '👤': '<blm-icon name="user"></blm-icon>',
  '👥': '<blm-icon name="users"></blm-icon>',
  '🏠': '<blm-icon name="home"></blm-icon>',
  '🌈': '<blm-icon name="rainbow"></blm-icon>',
  '☀️': '<blm-icon name="sun"></blm-icon>',
  '🌙': '<blm-icon name="moon"></blm-icon>',
  '⭐': '<blm-icon name="star"></blm-icon>',
  '🌊': '<blm-icon name="waves"></blm-icon>',
  '⛰️': '<blm-icon name="mountain"></blm-icon>',
  '🏔️': '<blm-icon name="mountain-snow"></blm-icon>',
  '🌸': '<blm-icon name="flower"></blm-icon>',
  '🌺': '<blm-icon name="flower-2"></blm-icon>',
  '🍀': '<blm-icon name="clover"></blm-icon>',
  '🌿': '<blm-icon name="leaf"></blm-icon>',
  '🌲': '<blm-icon name="tree-deciduous"></blm-icon>',
  '🎨': '<blm-icon name="palette"></blm-icon>',
  '🎭': '<blm-icon name="masks"></blm-icon>',
  '🎪': '<blm-icon name="tent"></blm-icon>',
  '🎯': '<blm-icon name="target"></blm-icon>',
  '🎲': '<blm-icon name="dice-5"></blm-icon>',
  '🎮': '<blm-icon name="gamepad-2"></blm-icon>',
  '🎰': '<blm-icon name="slot-machine"></blm-icon>',
  '🏆': '<blm-icon name="trophy"></blm-icon>',
  '🥇': '<blm-icon name="medal"></blm-icon>',
  '🎖️': '<blm-icon name="military-medal"></blm-icon>',
  '📊': '<blm-icon name="bar-chart-3"></blm-icon>',
  '📈': '<blm-icon name="trending-up"></blm-icon>',
  '📉': '<blm-icon name="trending-down"></blm-icon>',
  '💹': '<blm-icon name="trending-up"></blm-icon>',
  '💰': '<blm-icon name="dollar-sign"></blm-icon>',
  '💳': '<blm-icon name="credit-card"></blm-icon>',
  '🛒': '<blm-icon name="shopping-cart"></blm-icon>',
  '🛍️': '<blm-icon name="shopping-bag"></blm-icon>',
  '📦': '<blm-icon name="package"></blm-icon>',
  '📮': '<blm-icon name="mailbox"></blm-icon>',
  '📬': '<blm-icon name="mail"></blm-icon>',
  '📫': '<blm-icon name="mail"></blm-icon>',
  '📝': '<blm-icon name="file-text"></blm-icon>',
  '📄': '<blm-icon name="file"></blm-icon>',
  '📃': '<blm-icon name="file-text"></blm-icon>',
  '📑': '<blm-icon name="file-badge"></blm-icon>',
  '📋': '<blm-icon name="clipboard"></blm-icon>',
  '📁': '<blm-icon name="folder"></blm-icon>',
  '📂': '<blm-icon name="folder-open"></blm-icon>',
  '🗂️': '<blm-icon name="folder"></blm-icon>',
  '🗄️': '<blm-icon name="archive"></blm-icon>',
  '🗑️': '<blm-icon name="trash-2"></blm-icon>',
  '📰': '<blm-icon name="newspaper"></blm-icon>',
  '📚': '<blm-icon name="book-open"></blm-icon>',
  '📖': '<blm-icon name="book-open"></blm-icon>',
  '📕': '<blm-icon name="book"></blm-icon>',
  '📗': '<blm-icon name="book"></blm-icon>',
  '📘': '<blm-icon name="book"></blm-icon>',
  '📙': '<blm-icon name="book"></blm-icon>',
  '📓': '<blm-icon name="notebook"></blm-icon>',
  '📔': '<blm-icon name="notebook"></ble-icon>',
  '📒': '<blm-icon name="notebook"></blm-icon>',
  '📓': '<blm-icon name="notebook"></blm-icon>',
  '📜': '<blm-icon name="scroll"></blm-icon>',
  '📃': '<blm-icon name="scroll"></blm-icon>',
  '🧾': '<blm-icon name="receipt"></blm-icon>',
  '📎': '<blm-icon name="paperclip"></blm-icon>',
  '📏': '<blm-icon name="ruler"></blm-icon>',
  '📐': '<blm-icon name="ruler"></blm-icon>',
  '✂️': '<blm-icon name="scissors"></blm-icon>',
  '📌': '<blm-icon name="map-pin"></blm-icon>',
  '📍': '<blm-icon name="map-pin"></blm-icon>',
  '🗺️': '<blm-icon name="map"></blm-icon>',
  '🗾': '<blm-icon name="map"></blm-icon>',
  '🧭': '<blm-icon name="compass"></blm-icon>',
  '⏰': '<blm-icon name="alarm-clock"></blm-icon>',
  '⏱️': '<blm-icon name="timer"></blm-icon>',
  '⏲️': '<blm-icon name="timer"></blm-icon>',
  '🕐': '<blm-icon name="clock"></blm-icon>',
  '🕑': '<blm-icon name="clock"></blm-icon>',
  '🕒': '<blm-icon name="clock"></blm-icon>',
  '🕓': '<blm-icon name="clock"></blm-icon>',
  '🕔': '<blm-icon name="clock"></blm-icon>',
  '🕕': '<blm-icon name="clock"></blm-icon>',
  '🕖': '<blm-icon name="clock"></blm-icon>',
  '🕗': '<blm-icon name="clock"></blm-icon>',
  '🕘': '<blm-icon name="clock"></blm-icon>',
  '🕙': '<blm-icon name="clock"></blm-icon>',
  '🕚': '<blm-icon name="clock"></blm-icon>',
  '🕛': '<blm-icon name="clock"></blm-icon>',
  '🌑': '<blm-icon name="moon"></blm-icon>',
  '🌒': '<blm-icon name="moon"></blm-icon>',
  '🌓': '<blm-icon name="sun"></blm-icon>',
  '🌔': '<blm-icon name="sun"></blm-icon>',
  '🌕': '<blm-icon name="sun"></blm-icon>',
  '🌖': '<blm-icon name="sun"></blm-icon>',
  '🌗': '<blm-icon name="moon"></blm-icon>',
  '🌘': '<blm-icon name="moon"></blm-icon>',
  '🌙': '<blm-icon name="moon"></blm-icon>',
  '🌚': '<blm-icon name="moon"></blm-icon>',
  '🌛': '<blm-icon name="moon"></blm-icon>',
  '🌜': '<blm-icon name="moon"></blm-icon>',
  '🌡️': '<blm-icon name="thermometer"></blm-icon>',
  '☀️': '<blm-icon name="sun"></blm-icon>',
  '🌤️': '<blm-icon name="sun"></blm-icon>',
  '⛅': '<blm-icon name="cloud"></blm-icon>',
  '🌥️': '<blm-icon name="cloud"></blm-icon>',
  '☁️': '<blm-icon name="cloud"></blm-icon>',
  '🌧️': '<blm-icon name="cloud-rain"></blm-icon>',
  '⛈️': '<blm-icon name="cloud-lightning"></blm-icon>',
  '🌩️': '<blm-icon name="zap"></blm-icon>',
  '⚡': '<blm-icon name="zap"></blm-icon>',
  '❄️': '<blm-icon name="snowflake"></blm-icon>',
  '☃️': '<blm-icon name="snowflake"></blm-icon>',
  '⛄': '<blm-icon name="snowflake"></blm-icon>',
  '🌬️': '<blm-icon name="wind"></blm-icon>',
  '💨': '<blm-icon name="wind"></blm-icon>',
  '🌪️': '<blm-icon name="tornado"></blm-icon>',
  '🌫️': '<blm-icon name="cloud"></blm-icon>',
  '🌈': '<blm-icon name="rainbow"></blm-icon>',
  '🌂': '<blm-icon name="umbrella"></blm-icon>',
  '☂️': '<blm-icon name="umbrella"></blm-icon>',
  '☔': '<blm-icon name="umbrella"></blm-icon>',
  '🔔': '<blm-icon name="bell"></blm-icon>',
  '🔕': '<blm-icon name="bell-off"></blm-icon>',
  '🔇': '<blm-icon name="volume-x"></blm-icon>',
  '🔈': '<blm-icon name="volume"></blm-icon>',
  '🔉': '<blm-icon name="volume-1"></blm-icon>',
  '🔊': '<blm-icon name="volume-2"></blm-icon>',
  '📢': '<blm-icon name="megaphone"></blm-icon>',
  '📣': '<blm-icon name="megaphone"></blm-icon>',
  '📻': '<blm-icon name="radio"></blm-icon>',
  '🎙️': '<blm-icon name="mic"></blm-icon>',
  '🎚️': '<blm-icon name="sliders"></blm-icon>',
  '🎛️': '<blm-icon name="sliders"></blm-icon>',
  '🎵': '<blm-icon name="music"></blm-icon>',
  '🎶': '<blm-icon name="music"></blm-icon>',
  '🎼': '<blm-icon name="music-2"></blm-icon>',
  '🎹': '<blm-icon name="piano"></blm-icon>',
  '🎸': '<blm-icon name="guitar"></blm-icon>',
  '🎺': '<blm-icon name="trumpet"></blm-icon>',
  '🎻': '<blm-icon name="violin"></blm-icon>',
  '🥁': '<blm-icon name="drum"></blm-icon>',
  '🪘': '<blm-icon name="music"></blm-icon>',
  '🎷': '<blm-icon name="saxophone"></blm-icon>',
  '�蓝': '<blm-icon name="music"></blm-icon>',
  '🎤': '<blm-icon name="mic"></blm-icon>',
  '🎧': '<blm-icon name="headphones"></blm-icon>',
  '📱': '<blm-icon name="smartphone"></blm-icon>',
  '📲': '<blm-icon name="phone-call"></blm-icon>',
  '☎️': '<blm-icon name="phone"></blm-icon>',
  '📞': '<blm-icon name="phone"></blm-icon>',
  '📟': '<blm-icon name="pager"></blm-icon>',
  '📠': '<blm-icon name="fax"></blm-icon>',
  '🔋': '<blm-icon name="battery"></blm-icon>',
  '🔌': '<blm-icon name="plug"></blm-icon>',
  '💡': '<blm-icon name="lightbulb"></blm-icon>',
  '🔦': '<blm-icon name="flashlight"></blm-icon>',
  '🕯️': '<blm-icon name="flame"></blm-icon>',
  '🪔': '<blm-icon name="lamp"></blm-icon>',
  '🔋': '<blm-icon name="battery"></blm-icon>',
  '🔋': '<blm-icon name="battery-charging"></blm-icon>',
  '🔋': '<blm-icon name="battery-full"></blm-icon>',
  '🔋': '<blm-icon name="battery-low"></blm-icon>',
  '🔋': '<blm-icon name="battery-medium"></blm-icon>',
};

// 需要跳过的文件/目录
const SKIP_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'icon-',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
];

// 文件扩展名白名单
const ALLOWED_EXTENSIONS = ['.js', '.html', '.jsx', '.ts', '.tsx', '.vue', '.svelte'];

function shouldProcessFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return false;
  }

  for (const pattern of SKIP_PATTERNS) {
    if (filePath.includes(pattern)) {
      return false;
    }
  }

  return true;
}

function migrateFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    let newContent = content;
    let replacements = 0;

    for (const [emoji, replacement] of Object.entries(EMOJI_REPLACEMENTS)) {
      const regex = new RegExp(escapeRegExp(emoji), 'g');
      const matches = newContent.match(regex);
      if (matches) {
        newContent = newContent.replace(regex, replacement);
        replacements += matches.length;
      }
    }

    if (replacements > 0) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
      console.log(`✓ ${filePath} - ${replacements} 个 emoji 已替换`);
    }
  } catch (error) {
    console.error(`✗ ${filePath} - 错误: ${error.message}`);
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkDir(dirPath) {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      if (!SKIP_PATTERNS.some(pattern => file.includes(pattern))) {
        walkDir(filePath);
      }
    } else if (shouldProcessFile(filePath)) {
      migrateFile(filePath);
    }
  }
}

// 主程序
const targetDir = process.argv[2] || path.join(__dirname, '..', 'src');

console.log(`\n🔄 开始迁移 Emoji 图标...`);
console.log(`📁 目标目录: ${targetDir}\n`);

if (fs.existsSync(targetDir)) {
  walkDir(targetDir);
  console.log(`\n✅ 迁移完成！\n`);
} else {
  console.error(`❌ 目录不存在: ${targetDir}`);
  process.exit(1);
}
