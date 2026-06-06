// lib/asrHelper.js — ASR 服务工具（Whisper 视频转文字）
const db = require('../db');

// 读取 ASR 服务地址（来自 system_config）
async function getAsrUrl() {
  try {
    const { rows } = await db.query("SELECT value FROM system_config WHERE config_key = 'asr_url'");
    return (rows?.[0]?.value || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

// 从 TikHub 返回的 item 对象中提取最优 mp4 地址
function extractMp4Url(item) {
  if (!item) return '';
  const candidates = [
    item.video?.download_addr?.url_list?.[0],
    item.video?.play_addr?.url_list?.[0],
    item.video?.bit_rate?.[0]?.play_addr?.url_list?.[0],
  ];
  return candidates.find(u => u && u.startsWith('http')) || '';
}

/**
 * 提交 mp4 到本地 Whisper ASR 服务并等待结果
 * 采用异步提交 + 后端轮询模式，最长等待 90 秒
 * @param {string} mp4Url
 * @param {string} asrBaseUrl  例如 http://asr.yyagent.top
 * @returns {Promise<string>}  转录文本，失败返回空字符串
 */
async function asrTranscribe(mp4Url, asrBaseUrl) {
  if (!mp4Url || !asrBaseUrl) return '';
  try {
    // 1. 提交异步任务
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 12000);
    const submitResp = await fetch(`${asrBaseUrl}/asr/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mp4Url }),
      signal: ctrl1.signal,
    });
    clearTimeout(t1);
    if (!submitResp.ok) {
      console.warn('[ASR] submit 失败:', submitResp.status);
      return '';
    }
    const { task_id } = await submitResp.json();
    if (!task_id) return '';
    console.log(`[ASR] 任务已提交 task_id=${task_id}`);

    // 2. 轮询结果（3s 间隔，最多 90s = 30 次）
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 6000);
        const pollResp = await fetch(`${asrBaseUrl}/asr/task/${task_id}`, { signal: ctrl2.signal });
        clearTimeout(t2);
        if (pollResp.ok) {
          const result = await pollResp.json();
          if (result.status === 'done' && result.text) {
            console.log(`[ASR] 转录完成，${result.text.length} 字`);
            return result.text;
          }
          if (result.status === 'error') {
            console.warn('[ASR] 转录出错:', result.error);
            return '';
          }
        }
      } catch {}
    }
    console.warn('[ASR] 等待超时（90s）');
  } catch (err) {
    console.warn('[ASR] 调用失败:', err.message);
  }
  return '';
}

module.exports = { getAsrUrl, extractMp4Url, asrTranscribe };
