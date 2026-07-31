// scripts/fetch-meta-ads.mjs
//
// Busca investimento e campanhas da Meta Marketing API (Facebook/Instagram Ads)
// e mescla no data.json já gerado pelo fetch-shopify.mjs (precisa rodar DEPOIS dele).
//
// Variáveis de ambiente necessárias:
//   META_ACCESS_TOKEN   -> token do System User (permissão ads_read)
//   META_AD_ACCOUNT_ID  -> ex: "act_1234567890"
//
// Rodar localmente:
//   META_ACCESS_TOKEN=xxx META_AD_ACCOUNT_ID=act_xxx node scripts/fetch-meta-ads.mjs

import { readFile, writeFile } from "node:fs/promises";

const API_VERSION = "v21.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // formato: act_XXXXXXXXXX

if (!ACCESS_TOKEN || !AD_ACCOUNT_ID) {
  console.error(
    "Faltam variáveis de ambiente: META_ACCESS_TOKEN e/ou META_AD_ACCOUNT_ID"
  );
  process.exit(1);
}

const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

async function metaFetch(path) {
  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta API error ${res.status}: ${text}`);
  }
  return res.json();
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function main() {
  // Usa o mesmo período (últimos 30 dias) do dashboard do Shopify
  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - 30);

  const since = toDateStr(periodStart);
  const until = toDateStr(periodEnd);

  console.log(`Buscando investimento de ${since} até ${until}...`);

  // Investimento total da conta no período
  const accountInsights = await metaFetch(
    `/${AD_ACCOUNT_ID}/insights?fields=spend&time_range={"since":"${since}","until":"${until}"}`
  );
  const totalSpend = accountInsights.data && accountInsights.data[0]
    ? parseFloat(accountInsights.data[0].spend || "0")
    : 0;

  // Gasto por campanha no período
  const campaignInsights = await metaFetch(
    `/${AD_ACCOUNT_ID}/insights?level=campaign&fields=campaign_name,spend&time_range={"since":"${since}","until":"${until}"}&limit=100`
  );
  const spendByCampaign = {};
  for (const row of campaignInsights.data || []) {
    spendByCampaign[row.campaign_name] = parseFloat(row.spend || "0");
  }

  // Status das campanhas (pra saber quais estão ativas)
  const campaignsList = await metaFetch(
    `/${AD_ACCOUNT_ID}/campaigns?fields=name,effective_status&limit=200`
  );
  const activeCampaigns = (campaignsList.data || [])
    .filter((c) => c.effective_status === "ACTIVE")
    .map((c) => ({
      name: c.name,
      spend: Math.round((spendByCampaign[c.name] || 0) * 100) / 100,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Lê o data.json já gerado pelo fetch-shopify.mjs e mescla
  const raw = await readFile("data.json", "utf-8");
  const data = JSON.parse(raw);

  const revenue = data.kpis?.revenue?.value || 0;
  const roas = totalSpend ? Math.round((revenue / totalSpend) * 100) / 100 : null;

  const newCustomers = data.customers?.newCustomers || 0;
  const cac = totalSpend && newCustomers ? round2(totalSpend / newCustomers) : null;

  data.marketing = {
    spend: round2(totalSpend),
    roas,
    cac,
    activeCampaigns,
  };

  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log("data.json atualizado com dados da Meta Ads.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
