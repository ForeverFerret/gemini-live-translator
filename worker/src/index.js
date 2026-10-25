// Cloudflare Worker: Gemini Multimodal Live API 零延迟 WebSocket 安全中继代理

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS 跨域预检处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // 2. 普通 HTTP 状态健康检查
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({
        status: 'online',
        service: 'Gemini Live Translation Proxy',
        model: env.DEFAULT_MODEL || 'models/gemini-3.8-live',
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 3. 提取 API Key（优先使用 Cloudflare 环境变量/Secret，支持客户端自定义覆盖）
    const clientKey = url.searchParams.get('key');
    const apiKey = env.GEMINI_API_KEY || clientKey;

    if (!apiKey) {
      return new Response('GEMINI_API_KEY is not configured on this server', { status: 500 });
    }

    // 4. 发起上游 Google Gemini Live 官方全双工 WebSocket 连接
    const googleWsUrl = `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    try {
      const googleResp = await fetch(googleWsUrl, {
        headers: {
          'Upgrade': 'websocket'
        }
      });

      const googleWs = googleResp.webSocket;
      if (!googleWs) {
        return new Response('Upstream Google service rejected WebSocket upgrade', { status: 502 });
      }

      // 5. 采用 Cloudflare 内核级全双工直通中继管道
      return new Response(null, {
        status: 101,
        webSocket: googleWs,
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, { status: 500 });
    }
  }
};
