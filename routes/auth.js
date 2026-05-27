const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_EXPIRES = '7d';

// ==================== 中间件 ====================
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ code: 401, msg: '请先登录' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.id;
    req.userRole = payload.role;
    next();
  } catch {
    res.status(401).json({ code: 401, msg: 'Token 已过期，请重新登录' });
  }
}

// ==================== 阿里云短信 ====================
async function sendAliyunSms(phone, code, templateCode) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: process.env.ALIYUN_SMS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_SMS_KEY_SECRET,
    endpoint: 'https://dysmsapi.aliyuncs.com',
    apiVersion: '2017-05-25',
  });
  const result = await client.request('SendSms', {
    PhoneNumbers: phone,
    SignName: process.env.ALIYUN_SMS_SIGN || '烽鹏网络',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
  }, { method: 'POST' });
  if (result.Code !== 'OK') throw new Error(`短信发送失败：${result.Message || result.Code}`);
}

// ==================== 发送验证码 ====================
router.post('/send-sms', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
  }
  try {
    const { rows: recent } = await db.query(
      'SELECT id FROM sms_codes WHERE phone=? AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND) LIMIT 1',
      [phone]
    );
    if (recent.length > 0) return res.status(429).json({ code: 429, msg: '发送太频繁，请60秒后再试' });

    const { rows: userRows } = await db.query('SELECT id FROM users WHERE phone=?', [phone]);
    const isNew = userRows.length === 0;
    const templateCode = isNew
      ? (process.env.ALIYUN_SMS_TEMPLATE_REG || 'SMS_505140372')
      : (process.env.ALIYUN_SMS_TEMPLATE_LOGIN || 'SMS_504845448');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.query(
      'INSERT INTO sms_codes (phone, code, type, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [phone, code, isNew ? 'register' : 'login']
    );
    await sendAliyunSms(phone, code, templateCode);
    res.json({ code: 200, msg: '验证码已发送', data: { isNew } });
  } catch (err) {
    console.error('/send-sms error:', err.message);
    res.status(500).json({ code: 500, msg: err.message || '发送失败，请稍后重试' });
  }
});

// ==================== 验证码登录/注册 ====================
router.post('/sms-login', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ code: 400, msg: '手机号和验证码不能为空' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
  try {
    const { rows: codeRows } = await db.query(
      'SELECT * FROM sms_codes WHERE phone=? AND used=0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [phone]
    );
    const smsRecord = codeRows[0];
    if (!smsRecord || smsRecord.code !== String(code).trim()) {
      return res.status(401).json({ code: 401, msg: '验证码错误或已过期' });
    }
    await db.query('UPDATE sms_codes SET used=1 WHERE id=?', [smsRecord.id]);

    const { rows: userRows } = await db.query('SELECT * FROM users WHERE phone=?', [phone]);
    let user = userRows[0];
    if (!user) {
      const nickname = `用户${phone.slice(-4)}`;
      const { rows: ins } = await db.query(
        'INSERT INTO users (phone, nickname) VALUES (?, ?)',
        [phone, nickname]
      );
      const { rows: newRows } = await db.query(
        'SELECT id, phone, nickname, avatar, role, daily_limit FROM users WHERE id=?',
        [ins[0]?.id]
      );
      user = newRows[0];
    }
    const { password: _, avatar_image: _ai, ...safeUser } = user;
    const token = jwt.sign({ id: safeUser.id, role: safeUser.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const isNew = smsRecord.type === 'register';
    res.json({ code: 200, msg: isNew ? '注册成功' : '登录成功', data: { token, user: safeUser, isNew } });
  } catch (err) {
    console.error('/sms-login error:', err.message);
    res.status(500).json({ code: 500, msg: '登录失败，请稍后重试' });
  }
});

// ==================== 密码注册 ====================
router.post('/register', async (req, res) => {
  const { phone, password, nickname } = req.body;
  if (!phone || !password) return res.status(400).json({ code: 400, msg: '手机号和密码不能为空' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ code: 400, msg: '手机号格式不正确' });
  if (password.length < 6) return res.status(400).json({ code: 400, msg: '密码至少6位' });
  try {
    const { rows: existing } = await db.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing.length > 0) return res.status(409).json({ code: 409, msg: '该手机号已注册，请直接登录' });
    const hashed = bcrypt.hashSync(password, 10);
    const name = nickname || `用户${phone.slice(-4)}`;
    const { rows: ins } = await db.query(
      'INSERT INTO users (phone, password, nickname) VALUES (?, ?, ?)',
      [phone, hashed, name]
    );
    const { rows } = await db.query(
      'SELECT id, phone, nickname, avatar, role FROM users WHERE id = ?',
      [ins[0]?.id]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ code: 200, msg: '注册成功', data: { token, user } });
  } catch (err) {
    console.error('/register error:', err.message);
    res.status(500).json({ code: 500, msg: '注册失败，请稍后重试' });
  }
});

// ==================== 密码登录 ====================
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ code: 400, msg: '手机号和密码不能为空' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
    const user = rows[0];
    if (!user) return res.status(401).json({ code: 401, msg: '手机号未注册' });
    if (!user.password) return res.status(401).json({ code: 401, msg: '该账号未设置密码，请使用验证码登录' });
    const match = bcrypt.compareSync(password, user.password);
    if (!match) return res.status(401).json({ code: 401, msg: '密码错误' });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const { password: _, avatar_image: _ai, ...safeUser } = user;
    res.json({ code: 200, msg: '登录成功', data: { token, user: safeUser } });
  } catch (err) {
    console.error('/login error:', err.message);
    res.status(500).json({ code: 500, msg: '登录失败，请稍后重试' });
  }
});

// ==================== 当前用户信息 ====================
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, phone, nickname, avatar, role, daily_limit FROM users WHERE id=?',
      [req.userId]
    );
    if (!rows[0]) return res.status(404).json({ code: 404, msg: '用户不存在' });
    res.json({ code: 200, data: rows[0] });
  } catch (err) {
    res.status(500).json({ code: 500, msg: '获取用户信息失败' });
  }
});

module.exports = { router, requireAuth };
