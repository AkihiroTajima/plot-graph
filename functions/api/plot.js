// Cloudflare Pages Functions: /api/plot
// プロットグラフ（plot-graph.html）用の状態保存エンドポイント。
// 暗号文（E2Eで暗号化済みのグラフ JSON）を KV に読み書きする。
// 認証は state.js と同じ「共有トークン」方式（Authorization: Bearer <token>）。
//
// line-editor とは環境を分離する:
//   - KV バインドは専用の PLOT_VAULT（state.js の VAULT とは別の名前空間）
//   - シークレットは専用の PLOT_API_TOKEN（state.js の API_TOKEN とは別の値）
// これにより、データ・認証情報のいずれも line-editor と完全に独立する。

export async function onRequest(context) {
  const { request, env } = context;

  // --- 一時診断: /api/plot?diag=1 で、この関数に見えている env の「名前だけ」を返す ---
  // （シークレットの値は出さない。原因切り分け後に削除すること）
  if (new URL(request.url).searchParams.get('diag') === '1') {
    return new Response(JSON.stringify({
      envKeys: Object.keys(env),
      hasPlotApiToken: 'PLOT_API_TOKEN' in env && !!env.PLOT_API_TOKEN,
      hasPlotVault: 'PLOT_VAULT' in env && typeof env.PLOT_VAULT === 'object',
      deployedAt: new Date().toISOString()
    }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  // 共有トークン認証（プロットグラフ専用のシークレット）
  const expected = env.PLOT_API_TOKEN;
  if (!expected) {
    return new Response('Server not configured: PLOT_API_TOKEN is unset', { status: 503 });
  }
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 専用 KV 名前空間内の固定キー（単一ユーザー想定）
  const key = 'plot:default';

  if (request.method === 'GET') {
    const data = await env.PLOT_VAULT.get(key);
    return new Response(data || '', {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 2_000_000) {
      return new Response('Payload too large', { status: 413 });
    }
    await env.PLOT_VAULT.put(key, body);
    return new Response('ok');
  }

  return new Response('Method Not Allowed', { status: 405 });
}
