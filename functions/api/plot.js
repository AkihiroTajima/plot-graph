// Cloudflare Pages Functions: /api/plot
// プロットグラフ（plot-graph.html）用の状態保存エンドポイント。
// 暗号文（E2Eで暗号化済みのグラフ JSON）を KV に読み書きする。
// 認証は state.js と同じ「共有トークン」方式（Authorization: Bearer <API_TOKEN>）。
//
// line-editor の /api/state とは KV キーを分けている（vault:default ではなく plot:default）。
// 同じ VAULT バインドと API_TOKEN シークレットをそのまま再利用できるので、
// 新しい KV 名前空間やシークレットの追加登録は不要。

export async function onRequest(context) {
  const { request, env } = context;

  // 共有トークン認証（state.js と同一）
  const expected = env.API_TOKEN;
  if (!expected) {
    return new Response('Server not configured: API_TOKEN is unset', { status: 503 });
  }
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  // プロットグラフ専用の固定キー（line-editor の vault:default と衝突させない）
  const key = 'plot:default';

  if (request.method === 'GET') {
    const data = await env.VAULT.get(key);
    return new Response(data || '', {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 2_000_000) {
      return new Response('Payload too large', { status: 413 });
    }
    await env.VAULT.put(key, body);
    return new Response('ok');
  }

  return new Response('Method Not Allowed', { status: 405 });
}
