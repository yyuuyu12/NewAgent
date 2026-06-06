const db = require('./db');

// 幂等补字段：列不存在时才 ADD，避免每次启动报错
async function ensureColumn(table, column, definition) {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    if (rows && rows[0] && parseInt(rows[0].c) > 0) return;
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[DB] 已补字段 ${table}.${column}`);
  } catch (err) {
    console.warn(`[DB] 补字段 ${table}.${column} 失败:`, err.message);
  }
}

module.exports = async function initDb() {
  // 复用主库的 users / sms_codes / system_config / usage_logs / industry_videos 表

  // ── 改写历史 ──────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_history (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      source_type VARCHAR(20) DEFAULT 'manual',
      original    TEXT,
      rewritten   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 用户积分余额 ───────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_user_credits (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL UNIQUE,
      credits    INT NOT NULL DEFAULT 100,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 积分流水 ───────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_credit_logs (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      amount     INT NOT NULL,
      action     VARCHAR(50) NOT NULL,
      note       VARCHAR(200) DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 激活码 ────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_activation_codes (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      code           VARCHAR(32) NOT NULL UNIQUE,
      credits_amount INT NOT NULL DEFAULT 100,
      is_used        TINYINT(1) DEFAULT 0,
      used_by        INT DEFAULT NULL,
      used_at        DATETIME DEFAULT NULL,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 补字段：激活码类型（credits=积分码 / premium=进阶解锁码）+ 进阶天数（0=永久全开）──
  await ensureColumn('cw_activation_codes', 'type', "VARCHAR(20) NOT NULL DEFAULT 'credits'");
  await ensureColumn('cw_activation_codes', 'premium_days', 'INT NOT NULL DEFAULT 0');

  // ── 用户进阶（口播工坊）权限 ──────────────────────────────────────────────
  // premium_until 为 NULL=未开通；远期日期=已开通（永久全开写入 2099 年）
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_user_premium (
      user_id       INT NOT NULL UNIQUE,
      premium_until DATETIME DEFAULT NULL,
      granted_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 智能体配置 ────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_agents (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      name              VARCHAR(50) NOT NULL,
      description       VARCHAR(200) DEFAULT '',
      image_url         VARCHAR(500) DEFAULT '',
      emoji             VARCHAR(10) DEFAULT '🤖',
      coze_workflow_id  VARCHAR(100) DEFAULT '',
      coze_url          VARCHAR(500) DEFAULT '',
      input_fields      JSON,
      output_type       VARCHAR(20) DEFAULT 'text',
      credits_cost      INT NOT NULL DEFAULT 5,
      sort_order        INT DEFAULT 0,
      is_active         TINYINT(1) DEFAULT 1,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 智能体使用记录 ────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_agent_logs (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      agent_id   INT NOT NULL,
      input      TEXT,
      output     TEXT,
      status     VARCHAR(20) DEFAULT 'success',
      credits    INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 预置轻量小工具（6 个）──────────────────────────────────────────────────
  // 设计稿小工具集。仅在「表为空」或「仅含旧占位智能体」时写入，避免覆盖管理员自定义。
  const { rows: existingAgents } = await db.query('SELECT id, name FROM cw_agents');
  const OLD_PLACEHOLDERS = ['儿童绘本', '萌宠视频', '电商图片', '素材生成'];
  const onlyOldOrEmpty = existingAgents.length === 0 || existingAgents.every(a => OLD_PLACEHOLDERS.includes(a.name));
  const hasNewSet = existingAgents.some(a => a.name === '标题党生成器');

  if (onlyOldOrEmpty && !hasNewSet) {
    // 清理旧占位（仅删除已知占位名，保护其它数据）
    await db.query(
      "DELETE FROM cw_agents WHERE name IN ('儿童绘本','萌宠视频','电商图片','素材生成')"
    );

    const agents = [
      {
        name: '标题党生成器',
        description: '一句话生成 10 个高点击标题',
        credits_cost: 2, sort_order: 1,
        input_fields: JSON.stringify([
          { key: 'topic', label: '主题/内容', type: 'textarea', placeholder: '用一句话描述你的内容或主题...' }
        ])
      },
      {
        name: '黄金开头钩子',
        description: '3 秒抓住眼球的开场白',
        credits_cost: 2, sort_order: 2,
        input_fields: JSON.stringify([
          { key: 'topic', label: '视频主题', type: 'text', placeholder: '例如：减脂餐、职场穿搭、旅行攻略...' }
        ])
      },
      {
        name: '选题灵感库',
        description: '按赛道挖掘当下热门选题',
        credits_cost: 1, sort_order: 3,
        input_fields: JSON.stringify([
          { key: 'industry', label: '赛道/行业', type: 'text', placeholder: '例如：母婴、美妆、数码、健身...' }
        ])
      },
      {
        name: '评论区神回复',
        description: '高情商互动，养号涨粉',
        credits_cost: 1, sort_order: 4,
        input_fields: JSON.stringify([
          { key: 'comment', label: '原评论', type: 'textarea', placeholder: '粘贴需要回复的评论内容...' }
        ])
      },
      {
        name: '关键词标签',
        description: '智能推荐高流量话题标签',
        credits_cost: 1, sort_order: 5,
        input_fields: JSON.stringify([
          { key: 'content', label: '内容描述', type: 'textarea', placeholder: '描述你的内容，生成相关话题标签...' }
        ])
      },
      {
        name: '一键润色',
        description: '把口水话改成有质感的表达',
        credits_cost: 2, sort_order: 6,
        input_fields: JSON.stringify([
          { key: 'text', label: '原文', type: 'textarea', placeholder: '粘贴需要润色的文案...' }
        ])
      }
    ];

    for (const a of agents) {
      await db.query(
        'INSERT INTO cw_agents (name, description, emoji, output_type, credits_cost, sort_order, input_fields) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [a.name, a.description, '', 'text', a.credits_cost, a.sort_order, a.input_fields]
      );
    }
    console.log('[DB] 已预置 6 个轻量小工具');
  }

  // ── 原创工坊：Skill 文档 ──────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_skills (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL UNIQUE,
      version    VARCHAR(20) DEFAULT 'v1.0',
      rules      JSON DEFAULT ('{}'),
      keywords   JSON DEFAULT ('[]'),
      forbidden  JSON DEFAULT ('[]'),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 原创工坊：项目 ────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_original_projects (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      title      VARCHAR(255) NOT NULL,
      brief      TEXT,
      status     VARCHAR(20) DEFAULT 'draft',
      doc        LONGTEXT DEFAULT '',
      turns      INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── 原创工坊：项目对话消息 ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_original_messages (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      project_id     INT NOT NULL,
      role           VARCHAR(20) NOT NULL,
      content        TEXT NOT NULL,
      has_doc_update TINYINT DEFAULT 0,
      sync_label     VARCHAR(100) DEFAULT NULL,
      sync_done      VARCHAR(20) DEFAULT NULL,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_project (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('[DB] 数据库初始化完成');
};
