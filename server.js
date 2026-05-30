require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const initDb = require('./initDb');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '5mb' }));

const { router: authRouter } = require('./routes/auth');
const extractRouter  = require('./routes/extract');
const rewriteRouter  = require('./routes/rewrite');
const inspireRouter  = require('./routes/inspire');
const historyRouter  = require('./routes/history');
const { router: creditsRouter } = require('./routes/credits');
const agentsRouter   = require('./routes/agents');
const adminRouter    = require('./routes/admin');

app.use('/api/auth',    authRouter);
app.use('/api/extract', extractRouter);
app.use('/api/rewrite', rewriteRouter);
app.use('/api/inspire', inspireRouter);
app.use('/api/history', historyRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/agents',  agentsRouter);
app.use('/api/admin',   adminRouter);

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));
app.get('/api/health', (req, res) => res.json({ code: 200, msg: 'ok', time: new Date().toISOString() }));
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'), (err) => {
    if (err) res.status(404).json({ code: 404, msg: '管理后台页面不存在' });
  });
});
// 任何未匹配的 /api 请求（含 POST/PUT/DELETE）统一返回 JSON 404，避免前端收到 HTML
app.all('/api/*', (req, res) => {
  res.status(404).json({ code: 404, msg: `接口不存在: ${req.method} ${req.path}` });
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(404).json({ code: 404, msg: '接口不存在' });
  });
});
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ code: 500, msg: '服务器内部错误' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 爆款选题工作台启动成功`);
      console.log(`   端口: ${PORT}`);
      console.log(`   健康检查: http://localhost:${PORT}/api/health\n`);
    });
  })
  .catch(err => {
    console.error('❌ 数据库初始化失败:', err?.message || String(err));
    process.exit(1);
  });
