const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER || process.env.MYSQL_USERNAME || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || process.env.MYSQL_DB || 'app',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

pool.on('error', (err) => {
  console.error('[DB] MySQL pool error:', err.message);
});

module.exports = {
  query: async (text, params = []) => {
    const sql = text.replace(/\$\d+/g, '?');
    const [result] = await pool.query(sql, params);
    if (Array.isArray(result)) {
      return { rows: result };
    }
    return { rows: result.insertId > 0 ? [{ id: result.insertId }] : [] };
  }
};
