// scripts/fetch-shopify.mjs
//
// Busca pedidos e produtos da Shopify Admin API e gera /data.json
// com os números usados no dashboard (index.html).
//
// Desde 1º de janeiro de 2026 a Shopify mudou o fluxo de autenticação:
// não existe mais um único "token" pra copiar. Agora o app é criado no
// Dev Dashboard (dev.shopify.com/dashboard) e você usa um Client ID +
// Client secret pra pedir um token novo a cada execução (client credentials
// grant). Veja o passo a passo completo no README.
//
// Variáveis de ambiente necessárias:
//   SHOPIFY_STORE_DOMAIN     -> ex: "minhaloja.myshopify.com"
//   SHOPIFY_CLIENT_ID        -> Client ID do app no Dev Dashboard
//   SHOPIFY_CLIENT_SECRET    -> Client secret do app no Dev Dashboard
//
// Rodar localmente:
//   SHOPIFY_STORE_DOMAIN=minhaloja.myshopify.com SHOPIFY_CLIENT_ID=xxx SHOPIFY_CLIENT_SECRET=xxx node scripts/fetch-shopify.mjs

const API_VERSION = "2024-10";

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!STORE_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Faltam variáveis de ambiente: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID e/ou SHOPIFY_CLIENT_SECRET"
  );
  process.exit(1);
}

const BASE_URL = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`;
const STALLED_DAYS = 180; // "estoque parado" = sem vender há mais de 180 dias

// Troca Client ID + Client secret por um Admin API access token válido por 24h.
async function getAccessToken() {
  const res = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao obter access token (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

let ACCESS_TOKEN = null;

function authHeaders() {
  return {
    "X-Shopify-Access-Token": ACCESS_TOKEN,

    "Content-Type": "application/json",
  };
}

// Segue paginação por Link header, chamando `onPage(data)` a cada página.
async function fetchAllPages(initialPath, onPage) {
  let path = initialPath;
  while (path) {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    onPage(data);

    const link = res.headers.get("link");
    const next = link && link.split(",").find((p) => p.includes('rel="next"'));
    if (next) {
      const match = next.match(/<([^>]+)>/);
      path = match ? match[1].replace(BASE_URL, "") : null;
    } else {
      path = null;
    }
  }
}

async function fetchOrdersSince(sinceISO) {
  let orders = [];
  await fetchAllPages(
    `/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
    (data) => {
      orders = orders.concat(data.orders || []);
    }
  );
  return orders;
}

async function fetchAllProducts() {
  let products = [];
  await fetchAllPages(
    "/products.json?limit=250&fields=id,title,status,variants",
    (data) => {
      products = products.concat(data.products || []);
    }
  );
  return products;
}

function dayKey(dateStr) {
  return dateStr.slice(0, 10); // YYYY-MM-DD
}

function sum(list, fn) {
  return list.reduce((acc, item) => acc + fn(item), 0);
}

function pctChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log("Autenticando com a Shopify...");
  ACCESS_TOKEN = await getAccessToken();

  const now = new Date();
  const periodDays = 30;

  const periodEnd = new Date(now);
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - periodDays);

  const prevPeriodEnd = new Date(periodStart);
  const prevPeriodStart = new Date(periodStart);
  prevPeriodStart.setDate(prevPeriodStart.getDate() - periodDays);

  // Busca pedidos cobrindo os últimos STALLED_DAYS dias: precisamos desse
  // histórico maior para saber quais produtos não vendem há mais de 180 dias.
  const historyWindowStart = new Date(now);
  historyWindowStart.setDate(historyWindowStart.getDate() - STALLED_DAYS);

  console.log("Buscando pedidos...");
  const allOrders = await fetchOrdersSince(historyWindowStart.toISOString());

  // Considera apenas pedidos não cancelados
  const validOrders = allOrders.filter((o) => !o.cancelled_at);

  const inPeriod = (o, start, end) => {
    const d = new Date(o.created_at);
    return d >= start && d < end;
  };

  const currentOrders = validOrders.filter((o) => inPeriod(o, periodStart, periodEnd));
  const previousOrders = validOrders.filter((o) => inPeriod(o, prevPeriodStart, prevPeriodEnd));

  const orderRevenue = (o) => parseFloat(o.current_total_price || o.total_price || "0");

  const currentRevenue = sum(currentOrders, orderRevenue);
  const previousRevenue = sum(previousOrders, orderRevenue);

  const currentCount = currentOrders.length;
  const previousCount = previousOrders.length;

  const currentAOV = currentCount ? currentRevenue / currentCount : 0;
  const previousAOV = previousCount ? previousRevenue / previousCount : 0;

  // Série diária de receita (mesmo período do KPI) para o gráfico de evolução
  const revenueByDay = {};
  for (const o of currentOrders) {
    const key = dayKey(o.created_at);
    revenueByDay[key] = (revenueByDay[key] || 0) + orderRevenue(o);
  }
  const revenueSeries = Object.keys(revenueByDay)
    .sort()
    .map((date) => ({ date, revenue: round2(revenueByDay[date]) }));

  // Top produtos por receita (dentro do período atual) + unidades vendidas (para margem)
  const productRevenue = {};
  const productUnits = {};
  for (const o of currentOrders) {
    for (const li of o.line_items || []) {
      const name = li.title || li.name || "Produto";
      const lineTotal = parseFloat(li.price || "0") * (li.quantity || 1);
      productRevenue[name] = (productRevenue[name] || 0) + lineTotal;
      productUnits[name] = (productUnits[name] || 0) + (li.quantity || 0);
    }
  }

  // Custos unitários informados manualmente em custos.json (opcional).
  // Busca por PALAVRA-CHAVE: a chave do JSON só precisa aparecer em algum
  // lugar do nome do produto (não precisa ser o nome exato).
  let costEntries = [];
  try {
    const fsSync = await import("node:fs/promises");
    const rawCosts = await fsSync.readFile("custos.json", "utf-8");
    const parsed = JSON.parse(rawCosts);
    delete parsed._comentario;
    costEntries = Object.entries(parsed).map(([keyword, cost]) => ({
      keyword: keyword.toLowerCase(),
      cost,
    }));
  } catch {
    console.log("custos.json não encontrado ou inválido — seguindo sem cálculo de margem.");
  }

  function findUnitCost(productName) {
    const lower = productName.toLowerCase();
    const match = costEntries.find((entry) => lower.includes(entry.keyword));
    return match ? match.cost : null;
  }

  const topProducts = Object.entries(productRevenue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, revenue]) => {
      const units = productUnits[name] || 0;
      const unitCost = findUnitCost(name);
      const hasCost = typeof unitCost === "number";
      const cost = hasCost ? unitCost * units : null;
      const profit = hasCost ? revenue - cost : null;
      const marginPct = hasCost && revenue ? Math.round((profit / revenue) * 1000) / 10 : null;
      return {
        name,
        revenue: round2(revenue),
        pct: currentRevenue ? Math.round((revenue / currentRevenue) * 1000) / 10 : 0,
        units,
        marginPct,
      };
    });

  // Margem bruta geral do período (só considera produtos com custo cadastrado em custos.json)
  let revenueWithKnownCost = 0;
  let costOfKnownProducts = 0;
  for (const [name, revenue] of Object.entries(productRevenue)) {
    const unitCost = findUnitCost(name);
    if (typeof unitCost === "number") {
      revenueWithKnownCost += revenue;
      costOfKnownProducts += unitCost * (productUnits[name] || 0);
    }
  }
  const grossProfitKnown = revenueWithKnownCost - costOfKnownProducts;
  const overallMarginPct = revenueWithKnownCost
    ? Math.round((grossProfitKnown / revenueWithKnownCost) * 1000) / 10
    : null;
  const costCoveragePct = currentRevenue
    ? Math.round((revenueWithKnownCost / currentRevenue) * 1000) / 10
    : 0;

  // Unidades vendidas no período (para giro/cobertura de estoque)
  let unitsSoldInPeriod = 0;
  for (const o of currentOrders) {
    for (const li of o.line_items || []) {
      unitsSoldInPeriod += li.quantity || 0;
    }
  }

  // Variantes vendidas nos últimos STALLED_DAYS dias (para achar "estoque parado")
  const soldVariantIds = new Set();
  for (const o of validOrders) {
    for (const li of o.line_items || []) {
      if (li.variant_id) soldVariantIds.add(li.variant_id);
    }
  }

  // Clientes novos vs recompra (dentro do período atual)
  // Aproximação: customer.orders_count é o total histórico de pedidos do
  // cliente até agora. Se for 1, esse pedido é o único/primeiro dele.
  let newCustomers = 0;
  let returningCustomers = 0;
  const seenCustomerIds = new Set();
  for (const o of currentOrders) {
    const c = o.customer;
    if (!c || !c.id) continue; // pedido sem cliente identificado (guest sem cadastro)
    if (seenCustomerIds.has(c.id)) continue; // conta o cliente 1x no período
    seenCustomerIds.add(c.id);
    if ((c.orders_count || 0) <= 1) newCustomers += 1;
    else returningCustomers += 1;
  }
  const totalIdentifiedCustomers = newCustomers + returningCustomers;
  const recompraPct = totalIdentifiedCustomers
    ? Math.round((returningCustomers / totalIdentifiedCustomers) * 1000) / 10
    : null;

  // Estoque: total de peças, parado (sem venda há 180+ dias) e em ruptura
  console.log("Buscando produtos/estoque...");
  const products = await fetchAllProducts();

  let totalUnits = 0;
  let stalledSkuCount = 0;
  let stalledUnits = 0;
  let stockoutSkuCount = 0;

  for (const p of products) {
    if (p.status !== "active") continue;
    for (const v of p.variants || []) {
      const qty = v.inventory_quantity || 0;
      totalUnits += qty;

      if (qty <= 0) {
        stockoutSkuCount += 1;
        continue;
      }
      if (!soldVariantIds.has(v.id)) {
        stalledSkuCount += 1;
        stalledUnits += qty;
      }
    }
  }

  const avgDailyUnitsSold = unitsSoldInPeriod / periodDays;
  const coverageDays = avgDailyUnitsSold > 0 ? Math.round(totalUnits / avgDailyUnitsSold) : null;
  const turnoverRate = totalUnits > 0 ? Math.round((unitsSoldInPeriod / totalUnits) * 100) / 100 : null;

  const output = {
    updatedAt: now.toISOString(),
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
    },
    kpis: {
      revenue: {
        value: round2(currentRevenue),
        changePct: pctChange(currentRevenue, previousRevenue),
      },
      orders: {
        value: currentCount,
        changePct: pctChange(currentCount, previousCount),
      },
      aov: {
        value: round2(currentAOV),
        changePct: pctChange(currentAOV, previousAOV),
      },
    },
    revenueSeries,
    topProducts,
    inventory: {
      totalUnits,
      stalledSkuCount,
      stalledUnits,
      stockoutSkuCount,
      coverageDays,
      turnoverRate,
    },
    customers: {
      newCustomers,
      returningCustomers,
      recompraPct,
    },
    margin: {
      overallMarginPct,
      grossProfit: round2(grossProfitKnown),
      costCoveragePct,
    },
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile("data.json", JSON.stringify(output, null, 2));
  console.log("data.json gerado com sucesso.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
