const db = require('./db');

module.exports = async function initDb() {
  // 复用主库的 users / sms_codes / system_config / usage_logs / industry_videos 表
  // 这里只建本项目新增的表

  await db.query(`
    CREATE TABLE IF NOT EXISTS cw_history (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      source_type VARCHAR(20) DEFAULT 'manual',  -- manual/extract/inspire
      original    TEXT,
      rewritten   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('[DB] 数据库初始化完成');
};
