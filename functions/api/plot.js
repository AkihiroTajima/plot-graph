// Cloudflare Pages Functions: /api/plot
// プロットグラフ（plot-graph.html）用の状態保存エンドポイント。
// 暗号文（E2Eで暗号化済みのグラフ JSON）を KV に読み書きする。
// 認証は state.js と同じ「共有トークン」方式（Authorization: Bearer <token>）。
//
// line-editor とは環境を分離する:
//   - KV バインドは専用の PLOT_VAULT（state.js の VAULT とは別の名前空間）
//   - シークレットは専用の PLOT_API_TOKEN（state.js の API_TOKEN とは別の値）
// これにより、データ・認証情報のいずれも line-editor と完全に独立する。
//
// 同期モードは「オート」と「マニュアル」の2系統に分離して保存する:
//   - オート  : 単一スロット（plot:auto）に毎回「上書き保存」する自動セーブ用。
//   - マニュアル: 保存操作のたびに plot:manual:<ts> として新しいスナップショットを追加。
//                一覧取得・個別取得・削除に対応（読み込み機能用）。
//
// エンドポイント（いずれも Authorization: Bearer <PLOT_API_TOKEN> が必須）:
//   GET    /api/plot?verify=1               トークンの一致確認（200=一致）
//   GET    /api/plot?mode=auto              オートスロットの取得
//   PUT    /api/plot?mode=auto              オートスロットへ上書き保存
//   GET    /api/plot?mode=manual&list=1     マニュアルスナップショットの一覧（新しい順）
//   GET    /api/plot?mode=manual&key=...    指定スナップショットの取得
//   PUT    /api/plot?mode=manual            新しいスナップショットを追加
//   DELETE /api/plot?mode=manual&key=...    指定スナップショットの削除

const AUTO_KEY       = 'plot:auto';
const MANUAL_PREFIX  = 'plot:manual:';
const LEGACY_KEY     = 'plot:default';   // 旧・単一キー（オート取得時のフォールバック）
const MANUAL_MAX     = 30;               // 保持するスナップショット上限（古いものから削除）
const MAX_BODY       = 2_000_000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // --- 一時診断: /api/plot?diag=1 で、この関数に見えている env の「名前だけ」を返す ---
  // （シークレットの値は出さない。原因切り分け後に削除すること）
  if (url.searchParams.get('diag') === '1') {
    return new Response(JSON.stringify({
      envKeys: Object.keys(env),
      hasPlotApiToken: 'PLOT_API_TOKEN' in env && !!env.PLOT_API_TOKEN,
      hasPlotVault: 'PLOT_VAULT' in env && typeof env.PLOT_VAULT === 'object',
      deployedAt: new Date().toISOString()
    }, null, 2), { headers: JSON_HEADERS });
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

  // ここから先はトークン一致済み。
  // トークンの一致確認だけを行う軽量エンドポイント（クライアントのモード判定用）。
  if (url.searchParams.get('verify') === '1') {
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  const KV   = env.PLOT_VAULT;
  const mode = url.searchParams.get('mode') || 'auto';

  // ---------------- GET ----------------
  if (request.method === 'GET') {
    if (mode === 'manual') {
      // 一覧（新しい順、メタデータ付き）
      if (url.searchParams.get('list') === '1') {
        const out = [];
        let cursor;
        do {
          const page = await KV.list({ prefix: MANUAL_PREFIX, cursor });
          for (const k of page.keys) {
            const ts = Number(k.name.slice(MANUAL_PREFIX.length)) || 0;
            out.push({ key: k.name, ts, savedAt: new Date(ts).toISOString(),
                       size: (k.metadata && k.metadata.size) || null });
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        out.sort((a, b) => b.ts - a.ts); // 新しい順
        return new Response(JSON.stringify({ snapshots: out }), { headers: JSON_HEADERS });
      }
      // 個別取得
      const key = url.searchParams.get('key') || '';
      if (!key.startsWith(MANUAL_PREFIX)) {
        return new Response('Bad key', { status: 400 });
      }
      const data = await KV.get(key);
      if (data == null) return new Response('Not Found', { status: 404 });
      return new Response(data, { headers: JSON_HEADERS });
    }

    // オート（無ければ旧キーへフォールバック）
    let data = await KV.get(AUTO_KEY);
    if (data == null) data = await KV.get(LEGACY_KEY);
    return new Response(data || '', { headers: JSON_HEADERS });
  }

  // ---------------- PUT ----------------
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_BODY) {
      return new Response('Payload too large', { status: 413 });
    }

    if (mode === 'manual') {
      const ts  = Date.now();
      const key = MANUAL_PREFIX + ts;
      await KV.put(key, body, { metadata: { savedAt: new Date(ts).toISOString(), size: body.length } });
      await pruneSnapshots(KV); // 上限を超えた古いスナップショットを削除
      return new Response(JSON.stringify({ ok: true, key, ts }), { headers: JSON_HEADERS });
    }

    // オート: 単一スロットへ上書き
    await KV.put(AUTO_KEY, body);
    return new Response('ok');
  }

  // ---------------- DELETE ----------------
  if (request.method === 'DELETE') {
    if (mode === 'manual') {
      const key = url.searchParams.get('key') || '';
      if (!key.startsWith(MANUAL_PREFIX)) {
        return new Response('Bad key', { status: 400 });
      }
      await KV.delete(key);
      return new Response('ok');
    }
    await KV.delete(AUTO_KEY);
    return new Response('ok');
  }

  return new Response('Method Not Allowed', { status: 405 });
}

// マニュアルスナップショットを新しい順に MANUAL_MAX 件まで残し、古いものを削除する。
// キー名は plot:manual:<Date.now()> で 13 桁固定のため、辞書順 = 時系列順。
async function pruneSnapshots(KV) {
  const names = [];
  let cursor;
  do {
    const page = await KV.list({ prefix: MANUAL_PREFIX, cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  if (names.length <= MANUAL_MAX) return;
  names.sort(); // 古い順
  const excess = names.slice(0, names.length - MANUAL_MAX);
  await Promise.all(excess.map(n => KV.delete(n)));
}
