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

// 查询进阶（口播工坊）权限状态
async function getPremiumStatus(userId) {
  try {
    const { rows } = await db.query(
      'SELECT premium_until FROM cw_user_premium WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!rows.length || !rows[0].premium_until) return { premium: false, premium_until: null };
    const until = new Date(rows[0].premium_until);
    return { premium: until.getTime() > Date.now(), premium_until: rows[0].premium_until };
  } catch {
    return { premium: false, premium_until: null };
  }
}

module.exports.getOrInitCredits = getOrInitCredits;
module.exports.deductCredits = deductCredits;
module.exports.getPremiumStatus = getPremiumStatus;

// ── GET /api/credits/balance ──────────────────────────────────────────────
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const credits = await getOrInitCredits(req.userId);
    res.json({ code: 200, data: { credits } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── GET /api/credits/status ───────────────────────────────────────────────
// 一次性返回积分 + 进阶权限，供前端初始化用
router.get('/status', requireAuth, async (req, res) => {
  try {
    const credits = await getOrInitCredits(req.userId);
    const prem = await getPremiumStatus(req.userId);
    res.json({ code: 200, data: { credits, premium: prem.premium, premium_until: prem.premium_until } });
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
    const codeUpper = code.trim().toUpperCase();
    const isPremiumCode = (activation.type || 'credits') === 'premium';

    await db.query(
      'UPDATE cw_activation_codes SET is_used=1, used_by=?, used_at=NOW() WHERE id=?',
      [req.userId, activation.id]
    );

    await getOrInitCredits(req.userId);

    // 进阶解锁码：写入/续期口播工坊权限（premium_days=0 视为永久全开 → 2099 年）
    let premiumResult = { premium: false, premium_until: null };
    if (isPremiumCode) {
      const days = parseInt(activation.premium_days) || 0;
      const cur = await getPremiumStatus(req.userId);
      const base = (cur.premium && cur.premium_until) ? new Date(cur.premium_until) : new Date();
      let until;
      if (days <= 0) {
        until = new Date('2099-12-31T23:59:59');
      } else {
        until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      }
      const untilStr = until.toISOString().slice(0, 19).replace('T', ' ');
      await db.query(
        'INSERT INTO cw_user_premium (user_id, premium_until) VALUES (?, ?) ON DUPLICATE KEY UPDATE premium_until = VALUES(premium_until)',
        [req.userId, untilStr]
      );
      premiumResult = { premium: true, premium_until: untilStr };
    }

    // 附带的积分（积分码必给；进阶码若配置了 credits_amount 也一并发放）
    let added = 0;
    if (activation.credits_amount > 0) {
      added = activation.credits_amount;
      await db.query(
        'UPDATE cw_user_credits SET credits = credits + ? WHERE user_id = ?',
        [added, req.userId]
      );
      await db.query(
        'INSERT INTO cw_credit_logs (user_id, amount, action, note) VALUES (?, ?, "activate", ?)',
        [req.userId, added, `激活码 ${codeUpper}`]
      );
    }

    const { rows: updRows } = await db.query(
      'SELECT credits FROM cw_user_credits WHERE user_id = ?', [req.userId]
    );

    const msg = isPremiumCode
      ? (added > 0 ? `开通成功，进阶版已解锁，并获得 ${added} 积分` : '开通成功，进阶版已解锁')
      : `激活成功，获得 ${added} 积分`;
    res.json({
      code: 200,
      msg,
      data: { credits: updRows[0].credits, added, premium: premiumResult.premium, premium_until: premiumResult.premium_until }
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
