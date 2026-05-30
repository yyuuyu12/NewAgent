const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('./auth');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_EXPIRES = '7d';

// ── 管理员权限中间件 ──────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ code: 403, msg: '需要管理员权限' });
  next();
}
const admin = [requireAuth, requireAdmin];

// ── 工具：生成激活码（去除易混淆字符）────────────────────────────────────
function genCode(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ── POST /api/admin/login ─────────────────────────────────────────────────
// 管理员登录：账号密码，必须是 role=admin
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ code: 400, msg: '账号和密码不能为空' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
    const user = rows[0];
    if (!user || !user.password) return res.status(401).json({ code: 401, msg: '账号或密码错误' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ code: 401, msg: '账号或密码错误' });
    if (user.role !== 'admin') return res.status(403).json({ code: 403, msg: '该账号无管理员权限' });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ code: 200, msg: '登录成功', data: { token, nickname: user.nickname || '管理员' } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────
router.get('/stats', admin, async (req, res) => {
  const safe = async (sql, params = []) => {
    try { const { rows } = await db.query(sql, params); return rows[0] ? Object.values(rows[0])[0] : 0; }
    catch { return 0; }
  };
  try {
    const [users, premiumUsers, codesTotal, codesUsed, codesPremium, creditsIssued] = await Promise.all([
      safe('SELECT COUNT(*) c FROM users'),
      safe('SELECT COUNT(*) c FROM cw_user_premium WHERE premium_until > NOW()'),
      safe('SELECT COUNT(*) c FROM cw_activation_codes'),
      safe('SELECT COUNT(*) c FROM cw_activation_codes WHERE is_used = 1'),
      safe("SELECT COUNT(*) c FROM cw_activation_codes WHERE type = 'premium'"),
      safe('SELECT COALESCE(SUM(amount),0) s FROM cw_credit_logs WHERE amount > 0'),
    ]);
    res.json({
      code: 200,
      data: {
        users, premiumUsers,
        codesTotal, codesUsed, codesUnused: Math.max(0, codesTotal - codesUsed),
        codesPremium, creditsIssued,
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── GET /api/admin/codes ──────────────────────────────────────────────────
// query: status=all|used|unused, type=all|credits|premium, limit
router.get('/codes', admin, async (req, res) => {
  const { status = 'all', type = 'all' } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
  const where = [];
  const params = [];
  if (status === 'used') where.push('is_used = 1');
  else if (status === 'unused') where.push('is_used = 0');
  if (type === 'credits' || type === 'premium') { where.push('type = ?'); params.push(type); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.code, c.type, c.credits_amount, c.premium_days, c.is_used, c.used_by, c.used_at, c.created_at,
              u.phone AS used_by_phone
       FROM cw_activation_codes c
       LEFT JOIN users u ON u.id = c.used_by
       ${whereSql}
       ORDER BY c.id DESC LIMIT ${limit}`,
      params
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── POST /api/admin/codes ─────────────────────────────────────────────────
// body: { type:'credits'|'premium', count, credits_amount, premium_days, prefix }
router.post('/codes', admin, async (req, res) => {
  let { type = 'credits', count = 1, credits_amount = 0, premium_days = 0, prefix = '' } = req.body;
  type = (type === 'premium') ? 'premium' : 'credits';
  count = Math.min(100, Math.max(1, parseInt(count) || 1));
  credits_amount = Math.max(0, parseInt(credits_amount) || 0);
  premium_days = Math.max(0, parseInt(premium_days) || 0);
  prefix = String(prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (type === 'credits' && credits_amount <= 0) {
    return res.status(400).json({ code: 400, msg: '积分码必须设置发放积分数（大于0）' });
  }
  try {
    const created = [];
    for (let i = 0; i < count; i++) {
      let ok = false;
      for (let attempt = 0; attempt < 6 && !ok; attempt++) {
        const code = prefix + genCode(prefix ? 8 : 10);
        try {
          await db.query(
            'INSERT INTO cw_activation_codes (code, type, credits_amount, premium_days, is_used) VALUES (?, ?, ?, ?, 0)',
            [code, type, credits_amount, premium_days]
          );
          created.push(code);
          ok = true;
        } catch (e) {
          if (!/duplicate|ER_DUP_ENTRY/i.test(e.message)) throw e; // 非重复错误直接抛出
        }
      }
    }
    res.json({ code: 200, msg: `已生成 ${created.length} 个激活码`, data: { codes: created } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── DELETE /api/admin/codes/:id ───────────────────────────────────────────
// 仅允许删除未使用的码
router.delete('/codes/:id', admin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ code: 400, msg: '参数错误' });
  try {
    const { rows } = await db.query('SELECT is_used FROM cw_activation_codes WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return res.status(404).json({ code: 404, msg: '激活码不存在' });
    if (rows[0].is_used) return res.status(400).json({ code: 400, msg: '已使用的激活码不可删除' });
    await db.query('DELETE FROM cw_activation_codes WHERE id = ? AND is_used = 0', [id]);
    res.json({ code: 200, msg: '已删除' });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────
// query: q（手机号/昵称模糊），limit
router.get('/users', admin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const params = [];
  let whereSql = '';
  if (q) { whereSql = 'WHERE u.phone LIKE ? OR u.nickname LIKE ?'; params.push(`%${q}%`, `%${q}%`); }
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.phone, u.nickname, u.role, u.daily_limit, u.auth_expires_at,
              p.premium_until,
              COALESCE(cr.credits, 0) AS credits
       FROM users u
       LEFT JOIN cw_user_premium p ON p.user_id = u.id
       LEFT JOIN cw_user_credits cr ON cr.user_id = u.id
       ${whereSql}
       ORDER BY u.id DESC LIMIT ${limit}`,
      params
    );
    const now = Date.now();
    const data = rows.map(r => ({
      ...r,
      premium: !!(r.premium_until && new Date(r.premium_until).getTime() > now),
    }));
    res.json({ code: 200, data });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── POST /api/admin/users/:id/premium ─────────────────────────────────────
// body: { action:'grant'|'revoke', days }（days=0 表示永久全开 → 2099）
router.post('/users/:id/premium', admin, async (req, res) => {
  const userId = parseInt(req.params.id);
  const { action = 'grant', days = 0 } = req.body;
  if (!userId) return res.status(400).json({ code: 400, msg: '参数错误' });
  try {
    if (action === 'revoke') {
      await db.query(
        'INSERT INTO cw_user_premium (user_id, premium_until) VALUES (?, NULL) ON DUPLICATE KEY UPDATE premium_until = NULL',
        [userId]
      );
      return res.json({ code: 200, msg: '已取消进阶权限', data: { premium: false, premium_until: null } });
    }
    const d = Math.max(0, parseInt(days) || 0);
    // 现有有效期为基准续期
    const { rows } = await db.query('SELECT premium_until FROM cw_user_premium WHERE user_id = ? LIMIT 1', [userId]);
    const cur = rows[0] && rows[0].premium_until ? new Date(rows[0].premium_until) : null;
    const base = (cur && cur.getTime() > Date.now()) ? cur : new Date();
    let until;
    if (d <= 0) until = new Date('2099-12-31T23:59:59');
    else until = new Date(base.getTime() + d * 24 * 60 * 60 * 1000);
    const untilStr = until.toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      'INSERT INTO cw_user_premium (user_id, premium_until) VALUES (?, ?) ON DUPLICATE KEY UPDATE premium_until = VALUES(premium_until)',
      [userId, untilStr]
    );
    res.json({ code: 200, msg: d <= 0 ? '已开通永久进阶' : `已开通进阶 ${d} 天`, data: { premium: true, premium_until: untilStr } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
