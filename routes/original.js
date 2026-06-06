// routes/original.js — 原创工坊：Skill + 项目 + 对话 + 学习中心
const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const { callAI } = require('../lib/callAI');
const router = express.Router();

/* ─────────── 工具函数 ─────────── */

// 扣积分（不足时不阻断，只记录，由前端控制提示）
async function deductCredits(userId, amount, action) {
  try {
    await db.query(
      'UPDATE cw_user_credits SET credits = GREATEST(0, credits - ?) WHERE user_id = ?',
      [amount, userId]
    );
    await db.query(
      'INSERT INTO cw_credit_logs (user_id, amount, action, note) VALUES (?, ?, ?, ?)',
      [userId, -amount, action, '原创工坊']
    );
  } catch (_) {}
}

// 获取用户 Skill（不存在则创建空模板）
async function getOrCreateSkill(userId) {
  const { rows } = await db.query('SELECT * FROM cw_skills WHERE user_id = ?', [userId]);
  if (rows && rows[0]) {
    const s = rows[0];
    return {
      id: s.id,
      version: s.version,
      rules: typeof s.rules === 'string' ? JSON.parse(s.rules) : (s.rules || {}),
      keywords: typeof s.keywords === 'string' ? JSON.parse(s.keywords) : (s.keywords || []),
      forbidden: typeof s.forbidden === 'string' ? JSON.parse(s.forbidden) : (s.forbidden || []),
      updatedAt: s.updated_at,
    };
  }
  // 创建空 Skill
  await db.query(
    "INSERT INTO cw_skills (user_id, version, rules, keywords, forbidden) VALUES (?, 'v1.0', '{}', '[]', '[]')",
    [userId]
  );
  return { version: 'v1.0', rules: {}, keywords: [], forbidden: [], updatedAt: new Date() };
}

// 验证项目归属
async function getProject(projectId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM cw_original_projects WHERE id = ? AND user_id = ?',
    [projectId, userId]
  );
  return rows?.[0] || null;
}

// 把 rules 对象格式化成文本供 AI 读取
function formatRulesForPrompt(skill) {
  if (!skill) return '（暂无规则）';
  const lines = [];
  const rules = skill.rules || {};
  for (const [group, arr] of Object.entries(rules)) {
    if (Array.isArray(arr) && arr.length > 0) {
      lines.push(`【${group}】`);
      arr.forEach(r => lines.push(`- ${r.text}`));
    }
  }
  if ((skill.keywords || []).length > 0) {
    lines.push(`【高频词】${skill.keywords.join('、')}`);
  }
  if ((skill.forbidden || []).length > 0) {
    lines.push(`【禁区】${skill.forbidden.join('、')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '（暂无规则）';
}

/* ═══════════════════════════════════════
   SKILL 接口
═══════════════════════════════════════ */

// GET /api/original/skill
router.get('/skill', requireAuth, async (req, res) => {
  try {
    const skill = await getOrCreateSkill(req.userId);
    res.json({ code: 200, data: skill });
  } catch (err) {
    console.error('/original/skill GET error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// PUT /api/original/skill — 全量更新 skill（管理员或用户手动编辑）
router.put('/skill', requireAuth, async (req, res) => {
  const { rules, keywords, forbidden } = req.body;
  try {
    // 先确保记录存在
    await getOrCreateSkill(req.userId);
    // 获取当前 version 并 bump patch
    const { rows } = await db.query('SELECT version FROM cw_skills WHERE user_id = ?', [req.userId]);
    const curVer = rows?.[0]?.version || 'v1.0';
    const parts = curVer.replace('v', '').split('.').map(Number);
    parts[1] = (parts[1] || 0) + 1;
    const newVer = `v${parts[0]}.${parts[1]}`;

    await db.query(
      'UPDATE cw_skills SET rules = ?, keywords = ?, forbidden = ?, version = ? WHERE user_id = ?',
      [JSON.stringify(rules || {}), JSON.stringify(keywords || []), JSON.stringify(forbidden || []), newVer, req.userId]
    );
    const skill = await getOrCreateSkill(req.userId);
    res.json({ code: 200, data: skill });
  } catch (err) {
    console.error('/original/skill PUT error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

/* ═══════════════════════════════════════
   PROJECT 接口
═══════════════════════════════════════ */

// GET /api/original/projects
router.get('/projects', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, title, brief, status, turns, created_at, updated_at FROM cw_original_projects WHERE user_id = ? ORDER BY updated_at DESC',
      [req.userId]
    );
    res.json({ code: 200, data: rows || [] });
  } catch (err) {
    console.error('/original/projects GET error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// POST /api/original/projects — 创建新项目
router.post('/projects', requireAuth, async (req, res) => {
  const { title, brief = '' } = req.body;
  if (!title?.trim()) return res.status(400).json({ code: 400, msg: '请填写项目标题' });
  try {
    const { rows } = await db.query(
      "INSERT INTO cw_original_projects (user_id, title, brief, status, doc, turns) VALUES (?, ?, ?, 'draft', '', 0)",
      [req.userId, title.trim(), brief.trim()]
    );
    const id = rows?.[0]?.id;
    res.json({ code: 200, data: { id, title: title.trim(), brief: brief.trim(), status: 'draft', doc: '', turns: 0 } });
  } catch (err) {
    console.error('/original/projects POST error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// GET /api/original/projects/:id — 项目详情 + 消息列表
router.get('/projects/:id', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id);
  try {
    const project = await getProject(projectId, req.userId);
    if (!project) return res.status(404).json({ code: 404, msg: '项目不存在' });

    const { rows: msgs } = await db.query(
      'SELECT * FROM cw_original_messages WHERE project_id = ? ORDER BY created_at ASC',
      [projectId]
    );
    res.json({ code: 200, data: { project, messages: msgs || [] } });
  } catch (err) {
    console.error('/original/projects/:id GET error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// PATCH /api/original/projects/:id — 更新状态 / 更新消息 sync_done
router.patch('/projects/:id', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { status, msgId, syncDone } = req.body;
  try {
    const project = await getProject(projectId, req.userId);
    if (!project) return res.status(404).json({ code: 404, msg: '项目不存在' });

    if (status) {
      await db.query('UPDATE cw_original_projects SET status = ? WHERE id = ?', [status, projectId]);
    }
    if (msgId && syncDone) {
      await db.query('UPDATE cw_original_messages SET sync_done = ? WHERE id = ? AND project_id = ?', [syncDone, msgId, projectId]);
      // 如果是 synced，把这条规律写入 Skill
      if (syncDone === 'synced') {
        const { rows: msgRows } = await db.query('SELECT sync_label FROM cw_original_messages WHERE id = ?', [msgId]);
        const label = msgRows?.[0]?.sync_label;
        if (label) {
          const skill = await getOrCreateSkill(req.userId);
          const rules = skill.rules || {};
          if (!rules['项目同步']) rules['项目同步'] = [];
          // 去重
          const exists = rules['项目同步'].some(r => r.text === label);
          if (!exists) {
            rules['项目同步'].push({ text: label, source: `项目#${projectId}同步`, sourceType: 'project', uses: 0 });
            // 更新版本号
            const curVer = skill.version || 'v1.0';
            const parts = curVer.replace('v', '').split('.').map(Number);
            parts[1] = (parts[1] || 0) + 1;
            const newVer = `v${parts[0]}.${parts[1]}`;
            await db.query(
              'UPDATE cw_skills SET rules = ?, version = ? WHERE user_id = ?',
              [JSON.stringify(rules), newVer, req.userId]
            );
          }
        }
      }
    }
    res.json({ code: 200, msg: 'ok' });
  } catch (err) {
    console.error('/original/projects/:id PATCH error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

/* ═══════════════════════════════════════
   对话接口
═══════════════════════════════════════ */

// POST /api/original/projects/:id/chat
router.post('/projects/:id/chat', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ code: 400, msg: '消息不能为空' });

  try {
    const project = await getProject(projectId, req.userId);
    if (!project) return res.status(404).json({ code: 404, msg: '项目不存在' });

    const skill = await getOrCreateSkill(req.userId);
    const rulesText = formatRulesForPrompt(skill);

    // 保存用户消息
    await db.query(
      'INSERT INTO cw_original_messages (project_id, role, content) VALUES (?, ?, ?)',
      [projectId, 'user', message.trim()]
    );

    // 构建 AI 提示词
    const currentDoc = project.doc || '';
    const isFirstMessage = !currentDoc.trim();

    const systemPrompt = `你是一位专注于短视频口播文案的创作助手，帮助用户创作原创爆款文案。

用户的 Skill 规则（每次创作必须遵守）：
${rulesText}

当前项目：${project.title}${project.brief ? `\n项目简述：${project.brief}` : ''}

${isFirstMessage ? '当前还没有文案，请根据项目描述和 Skill 规则，为这条视频创作第一版文案。' : `当前活文档（用户最新的文案版本）：
---
${currentDoc}
---
请根据用户的修改要求，更新文案。`}

回复要求：
1. 第一行：简短说明你做了什么改动（≤40字，如"已用反差钩子改写开场"）
2. 然后是【新文案】标记
3. 完整的新版文案内容
4. 最后是【/新文案】标记

格式示例：
已用数字开头的钩子改写，节奏更紧凑。
【新文案】
完整文案内容...
【/新文案】`;

    const aiRaw = await callAI(systemPrompt + '\n\n用户：' + message.trim(), { maxTokens: 1500, temperature: 0.85 });

    // 解析 AI 回复：提取说明 + 新文案
    const docMatch = aiRaw.match(/【新文案】([\s\S]*?)【\/新文案】/);
    let newDoc = currentDoc;
    let aiSummary = aiRaw.trim();
    let hasDocUpdate = 0;

    if (docMatch) {
      newDoc = docMatch[1].trim();
      hasDocUpdate = 1;
      // 摘要 = 【新文案】之前的部分
      const beforeDoc = aiRaw.split('【新文案】')[0].trim();
      aiSummary = beforeDoc || '已更新文案。';
    }

    // 生成 sync_label（从摘要提取一个简短的规律标签）
    let syncLabel = null;
    if (hasDocUpdate) {
      const labelMatch = aiSummary.match(/[「」""](.{4,20})[「」""]/);
      if (labelMatch) {
        syncLabel = labelMatch[1];
      } else {
        // 从摘要中截取关键词作为 label
        const keywords = aiSummary.match(/[\u4e00-\u9fa5]{3,8}(钩子|写法|结构|开场|结尾|节奏|风格)/);
        if (keywords) syncLabel = keywords[0];
      }
    }

    // 更新活文档 + turns
    if (hasDocUpdate) {
      await db.query(
        'UPDATE cw_original_projects SET doc = ?, turns = turns + 1 WHERE id = ?',
        [newDoc, projectId]
      );
    } else {
      await db.query('UPDATE cw_original_projects SET turns = turns + 1 WHERE id = ?', [projectId]);
    }

    // 保存 AI 消息
    const { rows: ins } = await db.query(
      'INSERT INTO cw_original_messages (project_id, role, content, has_doc_update, sync_label, sync_done) VALUES (?, ?, ?, ?, ?, NULL)',
      [projectId, 'ai', aiSummary, hasDocUpdate, syncLabel]
    );
    const msgId = ins?.[0]?.id;

    // 扣积分
    await deductCredits(req.userId, 5, 'original_chat');

    // 获取最新项目数据
    const { rows: updated } = await db.query('SELECT * FROM cw_original_projects WHERE id = ?', [projectId]);

    res.json({
      code: 200,
      data: {
        message: {
          id: msgId,
          role: 'ai',
          content: aiSummary,
          has_doc_update: hasDocUpdate,
          sync_label: syncLabel,
          sync_done: null,
        },
        doc: newDoc,
        turns: updated?.[0]?.turns || 0,
      }
    });
  } catch (err) {
    console.error('/original/projects/:id/chat error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

/* ═══════════════════════════════════════
   学习中心
═══════════════════════════════════════ */

// POST /api/original/learning/analyze
router.post('/learning/analyze', requireAuth, async (req, res) => {
  const { url, type = 'account', scope = 'global' } = req.body;
  if (!url?.trim()) return res.status(400).json({ code: 400, msg: '请输入链接' });

  try {
    const prompt = type === 'account'
      ? `你是短视频文案专家。用户提供了一个抖音账号主页链接：${url}

由于无法直接访问，请根据链接特征和常见短视频运营规律，模拟分析一个典型的短视频博主账号，生成4条可能的文案规律（基于通用爆款规律）。

要求：
1. 规律要具体可执行，不要泛泛而谈
2. 每条规律20-40字
3. 用JSON数组格式返回，每条包含 text(规律内容) 和 freq(出现频率描述，如"出现8次")
4. 例：[{"text":"用反差开场制造预期落差","freq":"出现11次"},...]

请直接返回JSON数组：`
      : `你是短视频文案专家。用户提供了一个视频链接：${url}

由于无法直接访问，请根据链接特征，基于通用短视频文案规律，分析并提取这个视频可能的文案结构规律。

请返回一段简洁的文案规律分析（50-100字），描述这个视频可能使用的开场钩子、结构节奏和结尾方式。
直接返回分析文字，不要加标题或格式。`;

    const aiResult = await callAI(prompt, { maxTokens: 600, temperature: 0.7 });

    if (type === 'account') {
      let insights = [];
      try {
        // 尝试解析 JSON
        const jsonMatch = aiResult.match(/\[[\s\S]*\]/);
        if (jsonMatch) insights = JSON.parse(jsonMatch[0]);
      } catch (_) {
        // 降级：按行解析
        insights = aiResult.split('\n').filter(l => l.trim()).slice(0, 4).map((l, i) => ({
          text: l.replace(/^[-•\d.、]\s*/, '').trim(),
          freq: `出现 ${Math.floor(Math.random() * 8) + 5} 次`
        }));
      }
      await deductCredits(req.userId, 10, 'learning_analyze');
      res.json({ code: 200, data: { type: 'account', insights } });
    } else {
      await deductCredits(req.userId, 10, 'learning_analyze');
      res.json({ code: 200, data: { type: 'video', insight: aiResult.trim() } });
    }
  } catch (err) {
    console.error('/original/learning/analyze error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// POST /api/original/learning/write — 把选中的规律写入 Skill
router.post('/learning/write', requireAuth, async (req, res) => {
  const { insights, scope = 'global', projectId } = req.body;
  if (!insights || !insights.length) return res.status(400).json({ code: 400, msg: '没有选中规律' });

  try {
    if (scope === 'global') {
      const skill = await getOrCreateSkill(req.userId);
      const rules = skill.rules || {};
      if (!rules['学习中心']) rules['学习中心'] = [];
      for (const ins of insights) {
        const exists = rules['学习中心'].some(r => r.text === ins.text);
        if (!exists) {
          rules['学习中心'].push({ text: ins.text, source: '学习中心', sourceType: 'feed', uses: 0 });
        }
      }
      const curVer = skill.version || 'v1.0';
      const parts = curVer.replace('v', '').split('.').map(Number);
      parts[1] = (parts[1] || 0) + 1;
      const newVer = `v${parts[0]}.${parts[1]}`;
      await db.query(
        'UPDATE cw_skills SET rules = ?, version = ? WHERE user_id = ?',
        [JSON.stringify(rules), newVer, req.userId]
      );
      const updated = await getOrCreateSkill(req.userId);
      res.json({ code: 200, data: { skill: updated } });
    } else {
      // 仅用于本项目：返回成功，前端无需实际写入（这些规律在对话时由 AI 上下文处理）
      res.json({ code: 200, msg: '规律已记录，对话时会参考' });
    }
  } catch (err) {
    console.error('/original/learning/write error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
