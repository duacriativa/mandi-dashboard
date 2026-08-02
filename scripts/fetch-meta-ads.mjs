// scripts/fetch-meta-ads.mjs
//
// Busca dados da Meta Marketing API (Facebook/Instagram Ads) e mescla no
// data.json gerado pelo fetch-shopify.mjs (precisa rodar DEPOIS dele).
//
// Variáveis de ambiente necessárias:
//   META_ACCESS_TOKEN   -> token do System User (permissão ads_read)
//   META_AD_ACCOUNT_ID  -> ex: "act_1234567890"
//
// COMO FUNCIONA
// Tudo é buscado DIA A DIA (time_increment=1) em três níveis: campanha,
// conjunto de anúncios e anúncio. Isso é o que permite o dashboard mostrar,
// para QUALQUER período escolhido, apenas o que realmente rodou naquela
// janela — inclusive o intervalo personalizado do calendário.
//
// A Meta só devolve linhas dos dias em que houve entrega, então o volume
// de dados fica proporcional ao que de fato rodou (não explode).

import { readFile, writeFile } from "node:fs/promises";

// v25.0 é a atual (fev/2026); a v23.0 expirou em jun/2026. Versões antigas
// param de responder: developers.facebook.com/docs/graph-api/changelog
const API_VERSION = "v25.0";

// Histórico buscado. Quanto maior, maior o data.json — 180 dias cobre bem
// as análises de campanha sem inchar o arquivo.
const HISTORY_DAYS = 180;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;

if (!ACCESS_TOKEN || !AD_ACCOUNT_ID) {
  console.error("Faltam variáveis de ambiente: META_ACCESS_TOKEN e/ou META_AD_ACCOUNT_ID");
  process.exit(1);
}

const accountId = AD_ACCOUNT_ID.startsWith("act_") ? AD_ACCOUNT_ID : `act_${AD_ACCOUNT_ID}`;
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Token vai no header (não na URL) pra não vazar em log de erro.
async function metaFetch(url) {
  const full = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  const res = await fetch(full, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("Unsupported get request") || text.includes("does not exist")) {
      throw new Error(`Recurso inacessível — verifique se o token tem acesso à conta ${accountId}. Resposta: ${text}`);
    }
    if (res.status === 400 && text.toLowerCase().includes("version")) {
      throw new Error(`Versão da API rejeitada (${API_VERSION}) — atualize API_VERSION no topo deste arquivo. Resposta: ${text}`);
    }
    if (text.includes("OAuthException") || res.status === 401) {
      throw new Error(`Token inválido/expirado ou sem permissão ads_read. Resposta: ${text}`);
    }
    throw new Error(`Meta API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function metaFetchAll(path, label = "") {
  let rows = [];
  let url = path;
  let pages = 0;
  while (url && pages++ < 80) {
    const data = await metaFetch(url);
    rows = rows.concat(data.data || []);
    url = data.paging?.next || null;
  }
  if (label) console.log(`[info] ${label}: ${rows.length} registros`);
  return rows;
}

const toDateStr = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// Extrai quantidade e valor de compra dos campos de ação da Meta
function purchasesFrom(row) {
  const pick = (arr) => {
    if (!arr) return 0;
    const hit =
      arr.find((a) => a.action_type === "omni_purchase") ||
      arr.find((a) => a.action_type === "purchase") ||
      arr.find((a) => a.action_type === "offsite_conversion.fb_pixel_purchase");
    return hit ? parseFloat(hit.value || "0") : 0;
  };
  return { purchases: pick(row.actions), revenue: round2(pick(row.action_values)) };
}

// Resume a segmentação de um conjunto de anúncios em texto legível.
// O objeto `targeting` da Meta é enorme; aqui fica só o que ajuda a decidir.
function summarizeTargeting(t) {
  if (!t) return { resumo: "—", idade: "", genero: "", locais: "", interesses: [], publicos: 0 };

  const idade = t.age_min || t.age_max ? `${t.age_min ?? "18"}-${t.age_max ?? "65+"}` : "";

  let genero = "";
  if (Array.isArray(t.genders) && t.genders.length === 1) {
    genero = t.genders[0] === 1 ? "Homens" : "Mulheres";
  }

  const locais = [];
  const geo = t.geo_locations || {};
  for (const c of geo.cities || []) locais.push(c.name);
  for (const r of geo.regions || []) locais.push(r.name);
  for (const p of geo.countries || []) locais.push(p);
  if (geo.custom_locations?.length) locais.push(`${geo.custom_locations.length} raio(s) no mapa`);

  // Interesses podem estar em flexible_spec (segmentação detalhada) ou direto
  const interesses = new Set();
  const coletar = (spec) => {
    for (const grupo of spec || []) {
      for (const chave of ["interests", "behaviors", "demographics", "life_events", "work_positions"]) {
        for (const item of grupo[chave] || []) if (item && item.name) interesses.add(item.name);
      }
    }
  };
  coletar(t.flexible_spec);
  coletar([t]);

  const publicos = (t.custom_audiences?.length || 0) + (t.excluded_custom_audiences?.length || 0);

  const partes = [];
  if (genero) partes.push(genero);
  if (idade) partes.push(idade + " anos");
  if (locais.length) partes.push(locais.slice(0, 3).join(", ") + (locais.length > 3 ? ` +${locais.length - 3}` : ""));
  if (publicos) partes.push(`${publicos} público(s) salvo(s)`);
  if (interesses.size) partes.push(`${interesses.size} interesse(s)`);

  return {
    resumo: partes.length ? partes.join(" · ") : "Segmentação ampla (sem restrição)",
    idade,
    genero,
    locais: locais.slice(0, 6).join(", "),
    interesses: [...interesses].slice(0, 12),
    publicos,
  };
}

// Miniatura do criativo. A Meta gera URLs temporárias, mas como o workflow
// roda todo dia, o link é renovado antes de expirar.
function thumbFrom(creative) {
  if (!creative) return null;
  return (
    creative.thumbnail_url ||
    creative.image_url ||
    creative.object_story_spec?.link_data?.picture ||
    creative.object_story_spec?.video_data?.image_url ||
    null
  );
}

async function main() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - HISTORY_DAYS);
  const since = toDateStr(start);
  const until = toDateStr(now);
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  console.log(`Buscando dados da Meta Ads de ${since} até ${until}...`);

  const insightFields = "spend,impressions,clicks,actions,action_values";

  // ---- Nível conta (série diária, para os KPIs do topo) ----
  const contaRows = await metaFetchAll(
    `/${accountId}/insights?fields=${insightFields}&time_increment=1&time_range=${timeRange}&limit=500`,
    "dias da conta"
  );
  const dailyAds = contaRows
    .map((r) => {
      const p = purchasesFrom(r);
      return {
        date: r.date_start,
        spend: round2(parseFloat(r.spend || "0")),
        metaRevenue: p.revenue,
        purchases: p.purchases,
        impressions: parseInt(r.impressions || "0", 10),
        clicks: parseInt(r.clicks || "0", 10),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // ---- Metadados: campanhas, conjuntos (com público) e anúncios (com criativo) ----
  const campanhas = await metaFetchAll(
    `/${accountId}/campaigns?fields=id,name,status,effective_status,objective&limit=200`,
    "campanhas"
  );
  const conjuntos = await metaFetchAll(
    `/${accountId}/adsets?fields=id,name,campaign_id,status,effective_status,targeting,optimization_goal&limit=200`,
    "conjuntos"
  );
  const anuncios = await metaFetchAll(
    `/${accountId}/ads?fields=id,name,adset_id,campaign_id,status,effective_status,` +
    `creative{id,name,thumbnail_url,image_url,object_story_spec}&limit=200`,
    "anúncios"
  );

  // ---- Séries diárias por nível ----
  async function serieDiaria(level, idField, label) {
    const rows = await metaFetchAll(
      `/${accountId}/insights?level=${level}&fields=${idField},${insightFields}` +
      `&time_increment=1&time_range=${timeRange}&limit=500`,
      label
    );
    return rows.map((r) => {
      const p = purchasesFrom(r);
      return {
        d: r.date_start,
        id: r[idField],
        s: round2(parseFloat(r.spend || "0")),
        v: p.revenue,
        c: p.purchases,
        i: parseInt(r.impressions || "0", 10),
        k: parseInt(r.clicks || "0", 10),
      };
    });
  }

  const dailyByCampaign = await serieDiaria("campaign", "campaign_id", "dias × campanha");
  const dailyByAdset = await serieDiaria("adset", "adset_id", "dias × conjunto");
  const dailyByAd = await serieDiaria("ad", "ad_id", "dias × anúncio");

  // ---- Estruturas enxutas para o data.json ----
  const campaignsOut = campanhas.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.effective_status || c.status,
    objective: c.objective || "",
  }));

  const adsetsOut = conjuntos.map((a) => ({
    id: a.id,
    name: a.name,
    campaignId: a.campaign_id,
    status: a.effective_status || a.status,
    goal: a.optimization_goal || "",
    publico: summarizeTargeting(a.targeting),
  }));

  const adsOut = anuncios.map((a) => ({
    id: a.id,
    name: a.name,
    adsetId: a.adset_id,
    campaignId: a.campaign_id,
    status: a.effective_status || a.status,
    creativeName: a.creative?.name || "",
    thumb: thumbFrom(a.creative),
  }));

  // ---- Mescla no data.json ----
  const data = JSON.parse(await readFile("data.json", "utf-8"));

  const last30 = new Date(now);
  last30.setDate(last30.getDate() - 30);
  const d30 = toDateStr(last30);
  const spend30 = round2(dailyAds.filter((d) => d.date >= d30).reduce((s, d) => s + d.spend, 0));
  const revenue30 = data.periods?.["30d"]?.kpis?.revenue?.value ?? data.kpis?.revenue?.value ?? 0;
  const novos30 = data.periods?.["30d"]?.customers?.newCustomers ?? data.customers?.newCustomers ?? 0;

  data.marketing = {
    dailyAds,
    campaigns: campaignsOut,
    adsets: adsetsOut,
    ads: adsOut,
    dailyByCampaign,
    dailyByAdset,
    dailyByAd,
    updatedAt: now.toISOString(),
    historyStart: since,
    // Espelhos de 30 dias (compatibilidade com versões antigas do index.html)
    spend: spend30,
    roas: spend30 ? Math.round((revenue30 / spend30) * 100) / 100 : null,
    cac: spend30 && novos30 ? round2(spend30 / novos30) : null,
  };

  await writeFile("data.json", JSON.stringify(data, null, 2));

  const kb = Math.round(JSON.stringify(data.marketing).length / 1024);
  console.log(`data.json atualizado com dados da Meta Ads (~${kb} KB de dados de anúncio).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
