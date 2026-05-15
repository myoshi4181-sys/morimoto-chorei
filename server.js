const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;

// データ保存先: 環境変数で指定可能（Glitch等のクラウド用に .data/data.json 等を指定）
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const defaultData = {
  members: ['村上', '吉徳', '長瀬', '尾﨑', '大輔', '中山', '須藤', '島崎', '古川', '堀田'],
  startDate: '2026-05-18',   // 最初のマーケ担当週の月曜日
  startMemberIndex: 0,
  dayRecords: {}             // キー: 'YYYY-MM-DD', 値: { status, completedBy, coveredBy, note }
};

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(defaultData));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('データ読み込みエラー:', e.message);
    return JSON.parse(JSON.stringify(defaultData));
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/data', (req, res) => {
  res.json(loadData());
});

app.post('/api/day', (req, res) => {
  try {
    const data = loadData();
    const { date, record } = req.body;
    if (!date || !record) return res.status(400).json({ error: 'Invalid request' });
    if (!data.dayRecords) data.dayRecords = {};
    data.dayRecords[date] = { ...data.dayRecords[date], ...record };
    saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/members', (req, res) => {
  try {
    const data = loadData();
    if (!Array.isArray(req.body.members)) return res.status(400).json({ error: 'Invalid members' });
    data.members = req.body.members;
    saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const lanIPs = Object.values(interfaces)
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n=====================================');
  console.log('  マーケ朝礼当番アプリ 起動中');
  console.log('=====================================');
  console.log(`\n  このPC:       http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`  他のPC/スマホ: http://${ip}:${PORT}`));
  console.log('\n  このウィンドウを閉じるとアプリが停止します\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\nポート${PORT}はすでに使用中です。`);
    console.log(`アプリはすでに起動しています。`);
    console.log(`ブラウザで http://localhost:${PORT} を開いてください。\n`);
    process.exit(0);
  } else {
    console.error('サーバーエラー:', err.message);
    process.exit(1);
  }
});
