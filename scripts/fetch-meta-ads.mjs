// scripts/fetch-meta-ads.mjs
//
// Busca investimento e campanhas da Meta Marketing API (Facebook/Instagram Ads)
// e mescla no data.json já gerado pelo fetch-shopify.mjs (precisa rodar DEPOIS dele).
//
// Variáveis de ambiente necessárias:
//   META_ACCESS_TOKEN   -> token do System User (permissão ads_read, não expira)
//   META_AD_ACCOUNT_ID  -> ex: "act_1234567890"
//
// Rodar localmente:
//   META_ACCESS_TOKEN=xxx META_AD_ACCOUNT_ID=act_xxx node scripts/fetch-meta-ads.mjs
//
// O gasto é buscado DIA A DIA (time_increment=1). Isso é o que permite o
// dashboard calcular o investimento de qualquer período — incluindo o
// intervalo personalizado do calendário — sem rodar o script de novo.

import { readFile, writeFile } from "node:fs/promises";

// Versão da Marketing API. A v25.0 é a atual (fev/2026); a v23.0 expirou em
// jun/2026. Versões antigas param de responder, então isso precisa ser
// revisado de tempos em tempos: developers.facebook.com/docs/graph-api/changelog
const API_VERSION = "v25.0";

// Quantos dias de histórico buscar. A Meta guarda insights por 37 meses.
const HISTORY_DAYS = 400;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // formato: act_XXXXXXXXXX

if (!ACCESS_TOKEN || !AD_ACCOUNT_ID) {
  console.error("Faltam variáveis de ambiente: META_ACCESS_TOKEN e/ou META_AD_ACCOUNT_ID");
  process.exit(1);
}

const accountId = AD_ACCOUNT_ID.startsWith("act_") ? AD_ACCOUNT_ID : `act_${AD_ACCOUNT_ID}`;
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// O token vai no header (e não na URL) pra não vazar em log de erro.
async function metaFetch(url) {
  const full = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const res = await fetch(full, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    // Mensagens comuns, traduzidas para algo acionável:
    if (res.status === 400 && text.includes("version")) {
      throw new Error(
        `Versão da API rejeitada (${API_VERSION}). A Meta descontinua versões antigas — ` +
        `atualize API_VERSION no topo deste arquivo. Resposta: ${text}`
      );
    }
    if (res.status === 190) {
      throw new Error(`Token inválido ou expirado. Gere um novo token de System User. Resposta: ${text}`);
    }
    throw new Error(`Meta API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Segue a paginação da Meta (paging.next) até acabar.
async function metaFetchAll(path) {
  let rows = [];
  let url = path;
  let guard = 0;
  while (url && guard++ < 50) {
    const data = await metaFetch(url);
    rows = rows.concat(data.data || []);
    url = data.paging?.next || null;
  }
  return rows;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Receita que a PRÓPRIA META atribui aos anúncios (via pixel). Costuma ser
// maior que a receita real atribuível, porque a Meta credita a si mesma
// vendas que aconteceriam de qualquer forma.
function metaAttributedRevenue(row) {
  const values = row.action_values || [];
  const find = (type) => values.find((v) => v.action_type === type);
  const hit = find("omni_purchase") || find("purchase") || find("offsite_conversion.fb_pixel_purchase");
  return hit ? parseFloat(hit.value || "0") : 0;
}

async function main() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - HISTORY_DAYS);
  const since = toDateStr(start);
  const until = toDateStr(now);

  console.log(`Buscando investimento diário de ${since} até ${until}...`);

  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  // Gasto e conversões DIA A DIA (time_increment=1)
  const dailyRows = await metaFetchAll(
    `/${accountId}/insights?fields=spend,impressions,clicks,action_values` +
    `&time_increment=1&time_range=${timeRange}&limit=500`
  );

  const dailyAds = dailyRows
    .map((row) => ({
      date: row.date_start,
      spend: round2(parseFloat(row.spend || "0")),
      metaRevenue: round2(metaAttributedRevenue(row)),
      impressions: parseInt(row.impressions || "0", 10),
      clicks: parseInt(row.clicks || "0", 10),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalHistorySpend = round2(dailyAds.reduce((s, d) => s + d.spend, 0));
  console.log(`[info] ${dailyAds.length} dias com dados | investimento no período: R$ ${totalHistorySpend}`);

  // Campanhas: pega id + nome + status (paginado)
  const campaignsList = await metaFetchAll(
    `/${accountId}/campaigns?fields=id,name,effective_status&limit=200`
  );
  const campaignById = {};
  for (const c of campaignsList) campaignById[c.id] = c;

  // Gasto por campanha nos últimos 30 dias — cruzado por ID (não por nome,
  // que pode se repetir entre campanhas diferentes)
  const last30 = new Date(now);
  last30.setDate(last30.getDate() - 30);
  const range30 = encodeURIComponent(JSON.stringify({ since: toDateStr(last30), until }));
  const campaignRows = await metaFetchAll(
    `/${accountId}/insights?level=campaign&fields=campaign_id,campaign_name,spend,action_values` +
    `&time_range=${range30}&limit=500`
  );

  const activeCampaigns = campaignRows
    .map((row) => {
      const meta = campaignById[row.campaign_id];
      return {
        id: row.campaign_id,
        name: row.campaign_name || meta?.name || "(sem nome)",
        status: meta?.effective_status || "DESCONHECIDO",
        spend: round2(parseFloat(row.spend || "0")),
        metaRevenue: round2(metaAttributedRevenue(row)),
      };
    })
    .filter((c) => c.status === "ACTIVE" || c.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  // Mescla no data.json gerado pelo fetch-shopify.mjs
  const raw = await readFile("data.json", "utf-8");
  const data = JSON.parse(raw);

  // Compatibilidade: mantém os campos antigos calculados em 30 dias, que
  // versões anteriores do dashboard leem direto de data.marketing.
  const spend30 = round2(
    dailyAds.filter((d) => d.date >= toDateStr(last30)).reduce((s, d) => s + d.spend, 0)
  );
  const revenue30 = data.periods?.["30d"]?.kpis?.revenue?.value ?? data.kpis?.revenue?.value ?? 0;
  const newCustomers30 = data.periods?.["30d"]?.customers?.newCustomers ?? data.customers?.newCustomers ?? 0;

  data.marketing = {
    // Série diária: é o que permite calcular qualquer período no dashboard
    dailyAds,
    activeCampaigns,
    updatedAt: now.toISOString(),
    // Espelhos de 30 dias (compatibilidade)
    spend: spend30,
    roas: spend30 ? Math.round((revenue30 / spend30) * 100) / 100 : null,
    cac: spend30 && newCustomers30 ? round2(spend30 / newCustomers30) : null,
  };

  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log("data.json atualizado com dados da Meta Ads.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
