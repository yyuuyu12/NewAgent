const db = require('../db');

async function getAIConfig() {
  const keys = [
    'ai_provider', 'openai_api_key', 'openai_base_url', 'openai_model',
    'claude_api_key', 'claude_model', 'qwen_api_key', 'qwen_model',
    'zhipu_api_key', 'zhipu_model', 'deepseek_api_key', 'deepseek_model',
  ];
  const cfg = {};
  for (const k of keys) {
    const { rows } = await db.query('SELECT value FROM system_config WHERE config_key = $1', [k]);
    cfg[k] = rows[0]?.value || '';
  }
  return cfg;
}

async function callAI(prompt, opts = {}) {
  const cfg = await getAIConfig();
  const provider = cfg.ai_provider || 'openai';
  const maxTokens = opts.maxTokens || 2000;

  if (provider === 'openai' || provider === 'qwen') {
    const apiKey = provider === 'openai' ? cfg.openai_api_key : cfg.qwen_api_key;
    const baseUrl = cfg.openai_base_url || 'https://api.openai.com/v1';
    const model = provider === 'openai' ? (cfg.openai_model || 'gpt-3.5-turbo') : (cfg.qwen_model || 'qwen-turbo');
    if (!apiKey) throw new Error('AI Key 未配置，请联系管理员');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: opts.temperature || 0.8, max_tokens: maxTokens }),
    });
    if (!response.ok) throw new Error(`AI 接口错误: ${await response.text()}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`AI 返回内容异常: ${JSON.stringify(data).slice(0, 200)}`);
    return content;
  }

  if (provider === 'claude') {
    const apiKey = cfg.claude_api_key;
    const model = cfg.claude_model || 'claude-3-5-haiku-20241022';
    if (!apiKey) throw new Error('Claude Key 未配置');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new Error(`Claude 接口错误: ${await response.text()}`);
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('Claude 返回内容异常');
    return text;
  }

  if (provider === 'zhipu' || provider === 'glm') {
    const apiKey = cfg.zhipu_api_key;
    const model = cfg.zhipu_model || 'glm-4-flash';
    if (!apiKey) throw new Error('智谱 AI Key 未配置');
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new Error(`智谱接口错误: ${await response.text()}`);
    const data = await response.json();
    const zc = data.choices?.[0]?.message?.content;
    if (!zc) throw new Error('智谱返回内容异常');
    return zc;
  }

  if (provider === 'deepseek') {
    const apiKey = cfg.deepseek_api_key;
    const model = cfg.deepseek_model || 'deepseek-chat';
    if (!apiKey) throw new Error('DeepSeek Key 未配置');
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: opts.temperature || 0.8, max_tokens: maxTokens }),
    });
    if (!response.ok) throw new Error(`DeepSeek 接口错误: ${await response.text()}`);
    const data = await response.json();
    const dc = data.choices?.[0]?.message?.content;
    if (!dc) throw new Error(`DeepSeek 返回内容异常`);
    return dc;
  }

  throw new Error(`不支持的 AI 提供商: ${provider}`);
}

module.exports = { callAI };
