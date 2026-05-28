const express = require('express');
const db = require('../db');
const { requireAuth } = require('./auth');
const { deductCredits, getOrInitCredits } = require('./credits');
const router = express.Router();

// ── GET /api/agents ──────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, description, emoji, image_url, coze_url, input_fields, output_type, credits_cost, sort_order FROM cw_agents WHERE is_active=1 ORDER BY sort_order ASC'
    );
    // 解析 input_fields JSON
    const agents = rows.map(a => ({
      ...a,
      input_fields: typeof a.input_fields === 'string' ? JSON.parse(a.input_fields || '[]') : (a.input_fields || [])
    }));
    res.json({ code: 200, data: agents });
  } catch (err) {
    res.status(500).json({ code: 500, msg: err.message });
  }
});

// ── POST /api/agents/:id/run ──────────────────────────────────────────────
router.post('/:id/run', requireAuth, async (req, res) => {
  const agentId = parseInt(req.params.id);
  const { inputs = {} } = req.body;

  try {
    // 查智能体配置
    const { rows: agentRows } = await db.query(
      'SELECT * FROM cw_agents WHERE id = ? AND is_active = 1', [agentId]
    );
    if (!agentRows.length) return res.status(404).json({ code: 404, msg: '智能体不存在' });
    const agent = agentRows[0];

    // 检查积分
    const credits = await getOrInitCredits(req.userId);
    if (credits < agent.credits_cost) {
      return res.status(402).json({ code: 402, msg: `积分不足（当前 ${credits} 分，需要 ${agent.credits_cost} 分），请激活充值码` });
    }

    // 如果没有配置 workflow_id，返回提示
    if (!agent.coze_workflow_id) {
      return res.status(503).json({ code: 503, msg: '该智能体暂未配置工作流，敬请期待' });
    }

    // 获取 Coze API Key
    const { rows: cfgRows } = await db.query(
      "SELECT value FROM system_config WHERE config_key = 'coze_api_key' LIMIT 1"
    );
    const cozeKey = cfgRows[0]?.value;
    if (!cozeKey) return res.status(503).json({ code: 503, msg: 'Coze API Key 未配置，请联系管理员' });

    // 调用扣子工作流
    const cozeResp = await fetch('https://api.coze.cn/v1/workflow/run', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cozeKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        workflow_id: agent.coze_workflow_id,
        parameters: inputs
      }),
      signal: AbortSignal.timeout(60000)
    });

    const cozeData = await cozeResp.json();
    if (cozeData.code !== 0) {
      return res.status(500).json({ code: 500, msg: `工作流执行失败：${cozeData.msg || '未知错误'}` });
    }

    // 扣积分
    await deductCredits(req.userId, agent.credits_cost, 'agent_run', agent.name);

    // 记录使用日志
    const outputStr = typeof cozeData.data === 'string' ? cozeData.data : JSON.stringify(cozeData.data);
    await db.query(
      'INSERT INTO cw_agent_logs (user_id, agent_id, input, output, credits) VALUES (?, ?, ?, ?, ?)',
      [req.userId, agentId, JSON.stringify(inputs), outputStr, agent.credits_cost]
    );

    // 查剩余积分
    const { rows: credRows } = await db.query(
      'SELECT credits FROM cw_user_credits WHERE user_id = ?', [req.userId]
    );

    res.json({
      code: 200,
      data: {
        output: cozeData.data,
        output_type: agent.output_type,
        credits_used: agent.credits_cost,
        credits_left: credRows[0]?.credits ?? 0
      }
    });

  } catch (err) {
    console.error('/agents/:id/run error:', err.message);
    res.status(500).json({ code: 500, msg: err.message });
  }
});

module.exports = router;
