# ⚡ 避雷針 meme-guard

Solana 迷因幣風險掃描器（繁體中文）。

貼上代幣合約地址（Mint Address），3 秒算出 0–100 風險分數＋白話中文解說。

## 檢查項

| # | 項目 | 說明 |
|---|------|------|
| 1 | 鑄造權 Mint Authority | 莊家能不能無限印新幣砸盤 |
| 2 | 凍結權 Freeze Authority | 莊家能不能凍結你的幣 |
| 3 | 籌碼集中度 | 前十大錢包持倉比例 |
| 4 | 流動性深度 | 池子有多深（DexScreener） |
| 5 | 交易熱度 | 24H 交易量 |
| 6 | 池子年齡 | 上線多久 |

## 技術

- 純靜態單頁（`index.html`），無後端、無 key
- 資料源：DexScreener 免費 API＋Solana 公開 RPC（瀏覽器直連）
- 部署：Cloudflare Pages（GitHub main 自動部署）→ https://meme-guard.pages.dev

## 商業模式（規劃中）

- 免費：每日 10 次掃描
- Pro NT$149/月：無限掃描＋LINE 即時新幣警報＋莊家錢包異動追蹤
