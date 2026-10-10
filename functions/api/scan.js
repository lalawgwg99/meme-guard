/* Pages Function: /api/scan?mint=...
 * 瀏覽器只打同網域這支 API 一次；它在機房端抓 DexScreener＋Solana RPC（多節點備援），
 * 結果快取 90 秒。手機門號共用 IP 不再被公開 RPC 限流。
 */
const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
const DS = 'https://api.dexscreener.com/tokens/v1/solana/';
const CACHE_TTL = 90;

const TOKEN_KEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnXxV69U8Qprfz';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function extractMarket(dsRes) {
  if (!Array.isArray(dsRes) || !dsRes.length) return null;
  const p = dsRes
    .slice()
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return {
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

async function rpcCall(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  if (j.error) throw new Error('RPC_ERR:' + j.error.code);
  return j.result;
}

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
  if (owner !== TOKEN_KEG && owner !== TOKEN_2022) {
    // 假幣：發行程序是仿冒的。回 200 讓前端渲染紅色警報（附市場資料供比對）。
    // 這種情況不快取，每次都重新驗證。
    return { mint, fakeToken: true, fakeOwner: owner, market: extractMarket(dsRes) };
  }

  const mintInfo = parseMintAccount(accRes.value.data[0]);

  const market = extractMarket(dsRes);

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

export async function onRequest(context) {
  const { request } = context;
  const u = new URL(request.url);
  const mint = (u.searchParams.get('mint') || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return json({ error: 'INVALID_ADDR' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(u.toString(), request);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    body.cached = true;
    return json(body);
  }

  try {
    const data = await doScan(mint);
    if (data.fakeToken) {
      // 假幣不快取，每次都重新驗證
      return json(data);
    }
    data.cached = false;
    context.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        })
      )
    );
    return json(data);
  } catch (e) {
    if (e.status === 404) return json({ error: e.message }, 404);
    return json({ error: 'UPSTREAM_FAIL' }, 502);
  }
}
