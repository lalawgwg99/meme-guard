/* meme-guard-api — Solana 掃描代理 Worker
 * 為什麼需要它：手機瀏覽器直打 Solana 公開 RPC 會被限流（尤其手機門號共用 IP）。
 * 瀏覽器只打這支 Worker 一次，Worker 在機房端抓資料＋快取 90 秒＋多節點備援。
 * 無任何 secret，可公開。
 */
const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
const DS = 'https://api.dexscreener.com/tokens/v1/solana/';
const CACHE_TTL = 90;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });

async function rpcCall(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error('RPC_ERR:' + j.error.code);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/* 依序試多個節點，每個重試一次 */
async function rpcResilient(method, params) {
  let lastErr = null;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await rpcCall(url, method, params);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  throw lastErr || new Error('ALL_RPC_FAIL');
}

function parseMintAccount(b64) {
  const bin = atob(b64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const dv = new DataView(b.buffer);
  return {
    mintAuthRevoked: dv.getUint32(0, true) === 0,
    freezeAuthRevoked: dv.getUint32(46, true) === 0,
    supply: dv.getBigUint64(36, true).toString(),
    decimals: b[44],
  };
}

async function doScan(mint) {
  const [dsRes, accRes] = await Promise.all([
    fetch(DS + mint, { signal: AbortSignal.timeout(12000) })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    rpcResilient('getAccountInfo', [mint, { encoding: 'base64' }]),
  ]);

  if (!accRes || !accRes.value) {
    const e = new Error('NOT_FOUND');
    e.status = 404;
    throw e;
  }
  const owner = accRes.value.owner;
  if (
    owner !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
    owner !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnXxV69U8Qprfz'
  ) {
    const e = new Error('NOT_TOKEN');
    e.status = 404;
    throw e;
  }

  const mintInfo = parseMintAccount(accRes.value.data[0]);

  // 市場資料：取流動性最高的池子
  let market = null;
  if (Array.isArray(dsRes) && dsRes.length) {
    const p = dsRes
      .slice()
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    market = {
      name: p.baseToken?.name || null,
      symbol: p.baseToken?.symbol || null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ?? null,
      volume24h: p.volume?.h24 ?? null,
      priceChange24h: p.priceChange?.h24 ?? null,
      pairAgeMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null,
      url: p.url || null,
    };
  }

  // 持倉集中度（常被限流，失敗就 null）
  let top10Ratio = null;
  try {
    const [sup, large] = await Promise.all([
      rpcResilient('getTokenSupply', [mint]),
      rpcResilient('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
    ]);
    const dec = sup.value.decimals;
    const total = Number(sup.value.amount) / 10 ** dec;
    if (total > 0 && large.value) {
      const top = large.value
        .slice(0, 10)
        .reduce((s, x) => s + Number(x.amount) / 10 ** x.decimals, 0);
      top10Ratio = top / total;
    }
  } catch (e) {
    /* 降級：top10Ratio 保持 null */
  }

  return {
    mint,
    market,
    onchain: {
      mintAuthorityRevoked: mintInfo.mintAuthRevoked,
      freezeAuthorityRevoked: mintInfo.freezeAuthRevoked,
      top10Ratio,
    },
  };
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
    }

    if (u.pathname !== '/api/scan') {
      return json({ error: 'NOT_FOUND' }, 404);
    }

    const mint = (u.searchParams.get('mint') || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return json({ error: 'INVALID_ADDR' }, 400);
    }

    // 快取：同一個幣 90 秒內直接回
    const cache = caches.default;
    const cacheKey = new Request(u.toString(), req);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      body.cached = true;
      return json(body);
    }

    try {
      const data = await doScan(mint);
      data.cached = false;
      const resp = json(data);
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
          })
        )
      );
      return resp;
    } catch (e) {
      if (e.status === 404) return json({ error: e.message }, 404);
      return json({ error: 'UPSTREAM_FAIL' }, 502);
    }
  },
};
