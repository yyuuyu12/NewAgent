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

  // ── 预置4个智能体（仅首次）────────────────────────────────────────────────
  const { rows: existing } = await db.query('SELECT id FROM cw_agents LIMIT 1');
  if (existing.length === 0) {
    const agents = [
      {
        name: '儿童绘本',
        description: '输入故事主题，AI 生成儿童绘本故事与配图',
        emoji: '📚',
        output_type: 'image_text',
        credits_cost: 5,
        sort_order: 1,
        input_fields: JSON.stringify([
          { key: 'theme', label: '故事主题', type: 'text', placeholder: '例如：小兔子找朋友、勇敢的小熊...' },
          { key: 'age', label: '适合年龄', type: 'select', options: ['3-5岁','6-8岁','9-12岁'] },
          { key: 'style', label: '绘本风格', type: 'select', options: ['温馨可爱','奇幻冒险','科普知识'] }
        ])
      },
      {
        name: '萌宠视频',
        description: '输入宠物信息，生成萌宠短视频脚本与素材建议',
        emoji: '🐾',
        output_type: 'text',
        credits_cost: 5,
        sort_order: 2,
        input_fields: JSON.stringify([
          { key: 'pet_type', label: '宠物类型', type: 'text', placeholder: '例如：金毛、布偶猫、仓鼠...' },
          { key: 'theme', label: '视频主题', type: 'text', placeholder: '例如：日常记录、搞笑片段、技能展示...' }
        ])
      },
      {
        name: '电商图片',
        description: '输入商品信息，生成高转化率的电商主图文案',
        emoji: '🛍️',
        output_type: 'text',
        credits_cost: 5,
        sort_order: 3,
        input_fields: JSON.stringify([
          { key: 'product', label: '商品名称', type: 'text', placeholder: '例如：保温杯、连衣裙...' },
          { key: 'selling_points', label: '核心卖点', type: 'textarea', placeholder: '输入商品的主要特点和优势...' },
          { key: 'style', label: '风格', type: 'select', options: ['简洁大气','活泼促销','高端品质'] }
        ])
      },
      {
        name: '素材生成',
        description: '输入需求描述，一键生成各类创作素材',
        emoji: '✨',
        output_type: 'text',
        credits_cost: 3,
        sort_order: 4,
        input_fields: JSON.stringify([
          { key: 'type', label: '素材类型', type: 'select', options: ['文案标题','话题标签','评论回复','产品描述'] },
          { key: 'desc', label: '需求描述', type: 'textarea', placeholder: '描述你需要的素材内容...' }
        ])
      }
    ];

    for (const a of agents) {
      await db.query(
        'INSERT INTO cw_agents (name, description, emoji, output_type, credits_cost, sort_order, input_fields) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [a.name, a.description, a.emoji, a.output_type, a.credits_cost, a.sort_order, a.input_fields]
      );
    }
    console.log('[DB] 预置4个智能体完成');
  }

  console.log('[DB] 数据库初始化完成');
};
