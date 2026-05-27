const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const router = express.Router();

// 获取用户历史记录
router.get('/', requireAuth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const { rows } = await db.query(
      'SELECT id, source_type, original, rewritten, created_at FROM cw_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.userId, parseInt(limit), offset]
    );
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) AS total FROM cw_history WHERE user_id = ?',
      [req.userId]
    );
    res.json({ code: 200, data: { list: rows, total: parseInt(countRows[0].total) } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// 删除历史记录
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id FROM cw_history WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ code: 404, msg: '记录不存在' });
    await db.query('DELETE FROM cw_history WHERE id=?', [req.params.id]);
    res.json({ code: 200, msg: '已删除' });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
