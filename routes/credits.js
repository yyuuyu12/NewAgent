const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const router = express.Router();

// 获取或初始化用户积分
async function getOrInitCredits(userId) {
  const { rows } = await db.query('SELECT credits FROM cw_user_credits WHERE user_id = ?', [userId]);
  if (rows.length > 0) return rows[0].credits;
  // 首次初始化给 100 积分
  await db.query('INSERT INTO cw_user_credits (user_id, credits) VALUES (?, 100)', [userId]);
  await db.query(
    'INSERT INTO cw_credit_logs (user_id, amount, action, note) VALUES (?, 100, "init", "新用户赠送积分")',
    [userId]
  );
  return 100;
}

// 扣减积分（返回 { ok, credits } 或 { ok: false, msg }）
async function deductCredits(userId, amount, action, note = '') {
  const credits = await getOrInitCredits(userId);
  if (credits < amount) return { ok: false, msg: `积分不足（当前 ${credits} 分，需要 ${amount} 分）` };
  await db.query('UPDATE cw_user_credits SET credits = credits - ? WHERE user_id = ?', [amount, userId]);
  await db.query(
    'INSERT INTO cw_credit_logs (user_id, amount, action, note) VALUES (?, ?, ?, ?)',
    [userId, -amount, action, note]
  );
  return { ok: true, credits: credits - amount };
}

module.exports.getOrInitCredits = getOrInitCredits;
module.exports.deductCredits = deductCredits;

// ── GET /api/credits/balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const credits = await getOrInitCredits(req.userId);
    res.json({ code: 200, data: { credits } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── POST /api/credits/activate ────────────────────────────────────────────
router.post('/activate', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ code: 400, msg: '请输入激活码' });
  try {
    const { rows } = await db.query(
      'SELECT * FROM cw_activation_codes WHERE code = ? AND is_used = 0 LIMIT 1',
      [code.trim().toUpperCase()]
    );
    if (!rows.length) return res.status(400).json({ code: 400, msg: '激活码无效或已使用' });
    const activation = rows[0];

    await db.query(
      'UPDATE cw_activation_codes SET is_used=1, used_by=?, used_at=NOW() WHERE id=?',
      [req.userId, activation.id]
    );

    await getOrInitCredits(req.userId);
    await db.query(
      'UPDATE cw_user_credits SET credits = credits + ? WHERE user_id = ?',
      [activation.credits_amount, req.userId]
    );
    await db.query(
      'INSERT INTO cw_credit_logs (user_id, amount, action, note) VALUES (?, ?, "activate", ?)',
      [req.userId, activation.credits_amount, `激活码 ${code.trim().toUpperCase()}`]
    );

    const { rows: updRows } = await db.query(
      'SELECT credits FROM cw_user_credits WHERE user_id = ?', [req.userId]
    );
    res.json({
      code: 200,
      msg: `激活成功，获得 ${activation.credits_amount} 积分`,
      data: { credits: updRows[0].credits, added: activation.credits_amount }
    });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── GET /api/credits/logs ─────────────────────────────────────────────────
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT amount, action, note, created_at FROM cw_credit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports.router = router;
