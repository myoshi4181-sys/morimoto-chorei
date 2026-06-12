const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;

// ── ストレージ設定 ───────────────────────────────────────
// 環境変数 GIST_ID と GITHUB_TOKEN が両方設定されていれば GitHub Gist を使用、
// そうでなければローカルファイル（開発用）
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GITHUB_TOKEN;
const USE_GIST = !!(GIST_ID && GIST_TOKEN);

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
if (!USE_GIST) {
  const DATA_DIR = path.dirname(DATA_FILE);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 営業週メンバー（指定順）
const SALES_DEFAULT = ['山川', '柴田', '佐藤（悠）', '大塚', '松岡', '柳井', '中西', '楫野', '田中', '松本', '目谷'];

const defaultData = {
  members: ['村上', '吉徳', '長瀬', '尾﨑', '大輔', '中山', '須藤', '島崎', '古川', '堀田'],
  salesMembers: SALES_DEFAULT.slice(),
  startDate: '2026-05-18',
  startMemberIndex: 0,
  salesStartMemberIndex: 0,
  dayRecords: {}
};

// メモリキャッシュ（Gist API節約・読み込み高速化用）
let cache = null;

// ── 古いデータ形式 → 新形式への移行 ─────────────────────
function migrate(data) {
  if (!data.dayRecords) data.dayRecords = {};
  // 営業週メンバーが未登録の既存データ（Gist）には既定値を注入
  if (!Array.isArray(data.salesMembers) || data.salesMembers.length === 0) {
    data.salesMembers = SALES_DEFAULT.slice();
  }
  if (typeof data.salesStartMemberIndex !== 'number') {
    data.salesStartMemberIndex = 0;
  }
  for (const date in data.dayRecords) {
    const rec = data.dayRecords[date];
    if (rec.completedBy && !rec.actualBy) {
      rec.actualBy = rec.completedBy;
    }
    if (rec.coveredBy && rec.status === 'skipped' && !rec.actualBy) {
      // 旧「スキップ＋代行者あり」→ 新「完了＋actualBy」
      rec.status = 'completed';
      rec.actualBy = rec.coveredBy;
    }
    delete rec.completedBy;
    delete rec.coveredBy;
  }
  return data;
}

// ── Gist 読み書き ──────────────────────────────────────
async function loadFromGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      'Authorization': `Bearer ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'morimoto-chorei',
      'Cache-Control': 'no-cache'
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gist read failed: HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const gist = await res.json();
  const file = gist.files && gist.files['data.json'];
  if (!file || !file.content || !file.content.trim()) {
    // Gistが空 → デフォルトを書き込む
    const init = JSON.parse(JSON.stringify(defaultData));
    await saveToGist(init);
    return init;
  }
  return migrate(JSON.parse(file.content));
}

async function saveToGist(data) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'morimoto-chorei'
    },
    body: JSON.stringify({
      files: { 'data.json': { content: JSON.stringify(data, null, 2) } }
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gist write failed: HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
}

// ── 統一インターフェース ────────────────────────────────
async function loadData() {
  if (USE_GIST) {
    try {
      cache = await loadFromGist();
      return cache;
    } catch (e) {
      console.error('Gist load error:', e.message);
      if (cache) return cache;  // 障害時はキャッシュで暫定対応
      return JSON.parse(JSON.stringify(defaultData));
    }
  }
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(defaultData));
    }
    return migrate(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    console.error('Data load error:', e.message);
    return JSON.parse(JSON.stringify(defaultData));
  }
}

async function saveData(data) {
  cache = data;
  if (USE_GIST) {
    await saveToGist(data);
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── API エンドポイント ──────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    res.json(await loadData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/day', async (req, res) => {
  try {
    const data = await loadData();
    const { date, record } = req.body;
    if (!date || !record) return res.status(400).json({ error: 'Invalid request' });
    if (!data.dayRecords) data.dayRecords = {};
    data.dayRecords[date] = { ...data.dayRecords[date], ...record };
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2日まとめて更新（交換用、原子的）
app.post('/api/swap', async (req, res) => {
  try {
    const data = await loadData();
    const { dateA, recordA, dateB, recordB } = req.body;
    if (!dateA || !dateB || !recordA || !recordB) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    if (!data.dayRecords) data.dayRecords = {};
    data.dayRecords[dateA] = { ...data.dayRecords[dateA], ...recordA };
    data.dayRecords[dateB] = { ...data.dayRecords[dateB], ...recordB };
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/members', async (req, res) => {
  try {
    const data = await loadData();
    if (!Array.isArray(req.body.members)) return res.status(400).json({ error: 'Invalid members' });
    // dept で更新先を切替（既定はマーケ）。'sales' のときだけ営業メンバーを更新
    if (req.body.dept === 'sales') {
      data.salesMembers = req.body.members;
    } else {
      data.members = req.body.members;
    }
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 起動 ──────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const lanIPs = Object.values(interfaces)
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n=====================================');
  console.log('  もりもと朝礼当番アプリ 起動中');
  console.log('=====================================');
  console.log(`  Storage: ${USE_GIST ? `GitHub Gist (${GIST_ID})` : `Local file (${DATA_FILE})`}`);
  console.log(`\n  このPC:       http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`  他のPC/スマホ: http://${ip}:${PORT}`));
  console.log('\n  このウィンドウを閉じるとアプリが停止します\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\nポート${PORT}はすでに使用中です。\n`);
    process.exit(0);
  } else {
    console.error('サーバーエラー:', err.message);
    process.exit(1);
  }
});
