const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
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
  await db.query('INSERT INTO usage_logs (user_id, action) VALUES ($1, $2)', [userId, 'extract']);
  return { ok: true, remaining: user.daily_limit - used - 1 };
}

// 从抖音链接提取文案
router.post('/video', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ code: 400, msg: '请输入视频链接' });

  const usage = await checkUsage(req.userId);
  if (!usage.ok) return res.status(429).json({ code: 429, msg: usage.msg });

  try {
    const { rows } = await db.query("SELECT value FROM system_config WHERE config_key = 'tikhub_api_key'");
    const tikhubKey = rows[0]?.value;
    if (!tikhubKey) return res.status(503).json({ code: 503, msg: '抖音解析未配置，请联系管理员' });

    const videoResponse = await fetch(
      `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video?url=${encodeURIComponent(url.trim())}`,
      { headers: { 'Authorization': `Bearer ${tikhubKey}` } }
    );
    if (!videoResponse.ok) throw new Error(`视频解析失败: ${await videoResponse.text()}`);

    const videoData = await videoResponse.json();
    const item = videoData?.data?.aweme_detail;
    if (!item) throw new Error('无法获取视频信息，请检查链接是否正确');

    const awemeId = item.aweme_id;
    let subtitle = '';
    if (awemeId) {
      try {
        const subtitleResp = await fetch(
          `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_subtitle?aweme_id=${awemeId}`,
          { headers: { 'Authorization': `Bearer ${tikhubKey}` } }
        );
        if (subtitleResp.ok) {
          const subData = await subtitleResp.json();
          const subtitles = subData?.data?.subtitle_infos?.[0]?.subtitle_list;
          if (subtitles?.length) {
            subtitle = subtitles.map(s => s.words?.map(w => w.word).join('') || s.text).join('\n');
          }
        }
      } catch {}
    }

    const script = subtitle || item.desc || '未能提取到文案内容';
    res.json({
      code: 200,
      data: {
        script,
        title: item.desc?.slice(0, 50) || '无标题',
        author: item.author?.nickname || '未知',
        likes: item.statistics?.digg_count || 0,
        remaining: usage.remaining
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
