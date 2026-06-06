const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const { getAsrUrl, extractMp4Url, asrTranscribe } = require('../lib/asrHelper');
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

    // 从输入文本中提取真实链接（支持分享文本）
    const inputText = url.trim();
    const urlMatch = inputText.match(/https?:\/\/[^\s，。,）)]+/) || inputText.match(/(?:v\.douyin\.com|www\.douyin\.com)\/[^\s，。,]+/);
    const cleanUrl = urlMatch ? urlMatch[0].replace(/[）)>》\]]+$/, '') : inputText;
    const finalUrl = cleanUrl.startsWith('http') ? cleanUrl : 'https://' + cleanUrl;

    // 解析 aweme_id（支持短链重定向）
    let awemeId = null;
    const direct = finalUrl.match(/\/video\/(\d{10,20})/);
    if (direct) {
      awemeId = direct[1];
    } else {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 6000);
        const resp = await fetch(finalUrl, { method: 'GET', redirect: 'follow', signal: controller.signal });
        clearTimeout(tid);
        const m = (resp.url || '').match(/\/video\/(\d{10,20})/);
        if (m) awemeId = m[1];
      } catch {}
    }
    if (!awemeId) throw new Error('无法解析视频ID，请确认是有效的抖音视频链接');

    // 用 aweme_id 获取视频详情（兼容新旧 TikHub 接口）
    let item = null;
    for (const apiUrl of [
      `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${awemeId}`,
      `https://api.tikhub.io/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`,
    ]) {
      const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${tikhubKey}` } });
      if (r.ok) {
        const d = await r.json();
        item = d?.data?.aweme_detail || d?.data?.item_list?.[0] || null;
        if (item) break;
      }
    }
    if (!item) throw new Error('视频信息获取失败，请检查链接是否有效');

    // 1. 优先用 TikHub 内置字幕（快，无延迟）
    let script = '';
    try {
      const subtitleResp = await fetch(
        `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_subtitle?aweme_id=${awemeId}`,
        { headers: { Authorization: `Bearer ${tikhubKey}` } }
      );
      if (subtitleResp.ok) {
        const subData = await subtitleResp.json();
        const subtitles = subData?.data?.subtitle_infos?.[0]?.subtitle_list;
        if (subtitles?.length) {
          script = subtitles.map(s => s.words?.map(w => w.word).join('') || s.text).join('\n');
        }
      }
    } catch {}

    // 2. 没有内置字幕 → 发给本地 Whisper ASR 转录
    if (!script) {
      const mp4Url = extractMp4Url(item);
      const asrUrl = await getAsrUrl();
      if (mp4Url && asrUrl) {
        console.log(`[Extract] TikHub 无字幕，启动 ASR 转录: aweme_id=${awemeId}`);
        script = await asrTranscribe(mp4Url, asrUrl);
      }
    }

    // 3. ASR 也没结果 → 兜底用视频描述
    if (!script) script = item.desc || '未能提取到文案内容（视频可能无口播）';

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
