const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const router = express.Router();

// 获取行业列表
router.get('/industries', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT DISTINCT industry FROM industry_videos WHERE industry IS NOT NULL AND industry != "" ORDER BY industry LIMIT 50'
    );
    res.json({ code: 200, data: rows.map(r => r.industry) });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// 获取行业精选文案列表
router.get('/videos', requireAuth, async (req, res) => {
  const { industry, keyword, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let where = '1=1';
    const params = [];
    if (industry) { where += ' AND industry = ?'; params.push(industry); }
    if (keyword) { where += ' AND (title LIKE ? OR script LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

    const { rows } = await db.query(
      `SELECT id, title, industry, script, author_name, likes_count, duration, created_at
       FROM industry_videos WHERE ${where} AND script IS NOT NULL AND script != ''
       ORDER BY likes_count DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM industry_videos WHERE ${where} AND script IS NOT NULL AND script != ''`,
      params
    );

    res.json({ code: 200, data: { list: rows, total: parseInt(countRows[0].total), page: parseInt(page) } });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
