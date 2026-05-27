const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const { callAI } = require('../lib/callAI');
const router = express.Router();

async function checkUsage(userId) {
  const { rows } = await db.query('SELECT daily_limit, role FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) return { ok: false, msg: '用户不存在，请重新登录' };
  if (user.role === 'admin') return { ok: true, remaining: 999 };
  const { rows: u } = await db.query(
    'SELECT COUNT(*) AS cnt FROM usage_logs WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE',
    [userId]
  );
  const used = parseInt(u[0].cnt);
  if (used >= user.daily_limit) return { ok: false, msg: `今日次数已用完（${user.daily_limit}次），明日再来` };
  await db.query('INSERT INTO usage_logs (user_id, action) VALUES ($1, $2)', [userId, 'rewrite']);
  return { ok: true, remaining: user.daily_limit - used - 1 };
}

// AI 改写（仿写绕查重，生成3个版本）
router.post('/generate', requireAuth, async (req, res) => {
  const { text, source_type = 'manual' } = req.body;
  if (!text?.trim()) return res.status(400).json({ code: 400, msg: '请输入要改写的文案' });
  if (text.trim().length < 10) return res.status(400).json({ code: 400, msg: '文案内容太短，请输入更完整的文案' });

  const usage = await checkUsage(req.userId);
  if (!usage.ok) return res.status(429).json({ code: 429, msg: usage.msg });

  const prompt = `你是一位专业的短视频文案创作专家。请对以下文案进行仿写改造，要求：
1. 保留原文的写作风格、语气和情感基调
2. 保留原文的结构和表达节奏（如有钩子/铺垫/爆点/行动呼吁，结构不变）
3. 完全更换措辞和句式，确保内容原创，可以通过查重检测
4. 保留视频中的核心信息和关键卖点
5. 语言自然流畅，符合抖音/短视频风格

请生成3个不同的改写版本，版本之间用"===版本分隔==="分隔，每个版本前不需要加标题或编号，直接给内容。

原文案：
${text.trim()}

请直接输出3个改写版本：`;

  try {
    const result = await callAI(prompt, { maxTokens: 2000, temperature: 0.9 });
    const versions = result.split('===版本分隔===').map(v => v.trim()).filter(v => v.length > 0);

    // 保存到历史
    await db.query(
      'INSERT INTO cw_history (user_id, source_type, original, rewritten) VALUES (?, ?, ?, ?)',
      [req.userId, source_type, text.trim(), versions.join('\n\n---\n\n')]
    );

    res.json({ code: 200, data: { versions, remaining: usage.remaining } });
  } catch (err) {
    console.error('/rewrite/generate error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// AI 生成选题（根据关键词生成爆款标题）
router.post('/topics', requireAuth, async (req, res) => {
  const { keyword, count = 10 } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ code: 400, msg: '请输入关键词' });

  const usage = await checkUsage(req.userId);
  if (!usage.ok) return res.status(429).json({ code: 429, msg: usage.msg });

  const prompt = `你是抖音爆款内容策划专家。请根据关键词"${keyword.trim()}"，生成${count}个高点击率的短视频选题/标题。

要求：
1. 每个选题独占一行
2. 风格多样：包含情感共鸣型、干货知识型、悬念钩子型、对话亲切型等
3. 符合当前抖音流行的标题格式（带数字/疑问/对比/冲突感）
4. 不要加序号或其他格式，每行直接是标题内容
5. 标题长度在15-30字之间

关键词：${keyword.trim()}

请直接输出${count}个选题标题，每行一个：`;

  try {
    const result = await callAI(prompt, { maxTokens: 1000, temperature: 0.9 });
    const topics = result.split('\n').map(t => t.trim().replace(/^\d+[.、。\s]+/, '')).filter(t => t.length >= 5);
    res.json({ code: 200, data: { topics, remaining: usage.remaining } });
  } catch (err) {
    console.error('/rewrite/topics error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
