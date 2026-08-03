// scripts/fetch-shopify.mjs
//
// Busca pedidos e produtos da Shopify Admin API e gera /data.json
// com os números usados no dashboard (index.html), para VÁRIOS períodos
// de uma vez (o dashboard deixa trocar entre eles sem precisar rodar de novo).
//
// Duas formas de autenticar (o script detecta sozinho qual usar):
//
// 1) SHOPIFY_ACCESS_TOKEN direto — necessário quando quem configura o app
//    é apenas colaborador da loja (não dono da organização no Dev
//    Dashboard). É obtido uma vez, manualmente, via OAuth. Veja o README.
//
// 2) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET — client credentials grant,
//    mais simples, mas só funciona quando o app e a loja pertencem à MESMA
//    organização no Dev Dashboard (dono da loja = dono da organização).
//
// Variáveis de ambiente:
//   SHOPIFY_STORE_DOMAIN     -> ex: "minhaloja.myshopify.com" (sempre necessário)
//   SHOPIFY_ACCESS_TOKEN     -> opção 1
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET -> opção 2

const API_VERSION = "2024-10";

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const STATIC_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!STORE_DOMAIN || (!STATIC_TOKEN && (!CLIENT_ID || !CLIENT_SECRET))) {
  console.error(
    "Faltam variáveis de ambiente: defina SHOPIFY_STORE_DOMAIN e, além dele, SHOPIFY_ACCESS_TOKEN OU (SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET)"
  );
  process.exit(1);
}

const BASE_URL = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`;
const STALLED_DAYS = 180; // "estoque parado" = sem vender há mais de 180 dias
// "Estoque baixo" = variação que ainda tem peça, mas está acabando.
// Só conta como alerta se a variação teve venda recente (senão seria só
// uma peça encalhada com estoque baixo, que não precisa de reposição).
const LOW_STOCK_THRESHOLD = 3;
// Para "cliente novo vs. recompra" usamos o HISTÓRICO COMPLETO da loja (sem
// limite de dias) — é a mesma definição que a própria Shopify usa na
// métrica returning_customer_rate: recorrente = já teve QUALQUER pedido
// antes, não importa há quanto tempo.
const ALL_TIME_START = "2000-01-01T00:00:00Z";

// Troca Client ID + Client secret por um Admin API access token válido por 24h.
async function getAccessTokenViaClientCredentials() {
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

async function getAccessToken() {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  return getAccessTokenViaClientCredentials();
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

// Checkouts abandonados: cliente informou contato mas não finalizou a compra.
// A Shopify guarda esse histórico por cerca de 3 meses.
//
// Esta busca é OPCIONAL: exige a permissão de checkouts abandonados no token.
// Se falhar, seguimos sem esses dados — não faz sentido perder o dashboard de
// vendas inteiro por causa de uma métrica complementar.
async function fetchAbandonedCheckouts(sinceISO) {
  try {
    let checkouts = [];
    await fetchAllPages(
      `/checkouts.json?created_at_min=${encodeURIComponent(sinceISO)}&limit=250`,
      (data) => {
        checkouts = checkouts.concat(data.checkouts || []);
      }
    );
    return { ok: true, checkouts };
  } catch (err) {
    console.log(
      `[aviso] Não foi possível buscar checkouts abandonados (${err.message.slice(0, 120)}). ` +
      `Provavelmente falta a permissão de checkouts abandonados no token. ` +
      `O restante do dashboard continua normalmente.`
    );
    return { ok: false, checkouts: [] };
  }
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

// Receita LÍQUIDA de um item de pedido: preço de tabela × quantidade, menos
// o desconto aplicado naquele item especificamente (ex: blusa de R$79,90
// vendida por R$59,90 entra como R$59,90, não R$79,90).
function lineItemNetRevenue(li) {
  const gross = parseFloat(li.price || "0") * (li.quantity || 1);
  const discount = parseFloat(li.total_discount || "0");
  return Math.max(gross - discount, 0);
}

// Receita BRUTA do item: preço de tabela × quantidade, sem desconto.
function lineItemGrossRevenue(li) {
  return parseFloat(li.price || "0") * (li.quantity || 1);
}

function daysAgo(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() - days);
  return d;
}

function monthStartUTC(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
}

// offset 0 = do dia 1 do mês atual até agora; -1 = mês passado inteiro; -2 = dois meses atrás inteiro
function calendarMonthRange(now, offset) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + offset;
  const normM = ((m % 12) + 12) % 12;
  const yearAdjust = Math.floor(m / 12) - (m < 0 && m % 12 !== 0 ? 1 : 0);
  const start = monthStartUTC(y + yearAdjust, normM);
  const end = offset === 0 ? now : monthStartUTC(y + yearAdjust, normM + 1);
  return { start, end };
}

async function main() {
  console.log("Autenticando com a Shopify...");
  ACCESS_TOKEN = await getAccessToken();

  const now = new Date();

  // Busca TODO o histórico de pedidos da loja. É mais dados que o
  // necessário só pra um período, mas é o que garante que "cliente
  // recorrente" seja calculado certo (qualquer pedido anterior conta) e
  // permite montar vários períodos sem buscar de novo.
  console.log("Buscando pedidos (histórico completo)...");
  const allOrders = await fetchOrdersSince(ALL_TIME_START);

  // Calculamos os números de DUAS formas, e o dashboard deixa escolher:
  //
  // "total"     -> Total em vendas: todo pedido que não foi 100% reembolsado
  //                (current_total_price > 0). É a mesma definição que a
  //                própria aba "Vendas" da Shopify usa no relatório
  //                "Total de vendas" — inclui pedidos cancelados que nunca
  //                chegaram a ser pagos, contanto que não tenham sido
  //                estornados (porque não tem o que estornar).
  //
  // "confirmed" -> Pagamentos confirmados: dinheiro que REALMENTE entrou no
  //                caixa, baseado no status de pagamento (financial_status).
  //                Exclui pedidos com pagamento pendente/expirado/anulado,
  //                mesmo que não tenham sido formalmente cancelados.
  const allSalesOrders = allOrders.filter(
    (o) => parseFloat(o.current_total_price ?? o.total_price ?? "0") > 0
  );
  const PAID_STATUSES = new Set(["paid", "partially_paid", "partially_refunded"]);
  const confirmedOrders = allOrders.filter((o) => PAID_STATUSES.has(o.financial_status));

  const orderRevenue = (o) => parseFloat(o.current_total_price || o.total_price || "0");

  console.log(
    `[info] pedidos: ${allOrders.length} no total | ${allSalesOrders.length} em "total de vendas" | ${confirmedOrders.length} com pagamento confirmado`
  );

  // Clientes: quantos pedidos cada um tem no histórico completo (não usamos
  // o campo `orders_count` do cliente porque a Shopify pode restringir esse
  // dado sem uma aprovação extra de "Protected Customer Data"). Baseado em
  // pagamentos confirmados — é o que reflete cliente que realmente comprou.
  const ordersPerCustomer = {};
  for (const o of confirmedOrders) {
    const c = o.customer;
    if (!c || !c.id) continue;
    ordersPerCustomer[c.id] = (ordersPerCustomer[c.id] || 0) + 1;
  }

  // Estoque: total de peças, parado (sem venda há 180+ dias) e em ruptura.
  // Isso não depende do período selecionado no dashboard, é sempre "agora".
  console.log("Buscando produtos/estoque...");
  const products = await fetchAllProducts();

  const stalledWindowStart = daysAgo(now, STALLED_DAYS);
  const soldVariantIdsRecently = new Set();
  const lastSoldByVariant = {}; // variant_id -> data da última venda (histórico completo)
  for (const o of confirmedOrders) {
    const recent = new Date(o.created_at) >= stalledWindowStart;
    for (const li of o.line_items || []) {
      if (!li.variant_id) continue;
      if (recent) soldVariantIdsRecently.add(li.variant_id);
      const prev = lastSoldByVariant[li.variant_id];
      if (!prev || o.created_at > prev) lastSoldByVariant[li.variant_id] = o.created_at;
    }
  }

  let totalUnits = 0;
  let stalledSkuCount = 0;
  let stalledUnits = 0;
  let stockoutSkuCount = 0;
  const stalledList = [];  // detalhe das peças paradas (para decidir promoção)
  const stockoutList = []; // detalhe das variações zeradas (para repor)
  const lowStockList = []; // vendendo, mas com poucas peças (repor logo)
  const productStalledList = []; // PRODUTO inteiro parado (nenhuma variação vendeu)
  for (const p of products) {
    if (p.status !== "active") continue;
    // Agregado do produto inteiro (para saber se NENHUMA variação vendeu)
    let prodQty = 0, prodValue = 0, prodSoldRecently = false, prodLastSold = null, prodVariants = 0;
    for (const v of p.variants || []) {
      const qty = v.inventory_quantity || 0;
      totalUnits += qty;
      const lastSold = lastSoldByVariant[v.id] || null;
      const daysSince = lastSold
        ? Math.floor((now - new Date(lastSold)) / 86400000)
        : null; // null = nunca vendeu
      const price = parseFloat(v.price || "0");
      prodVariants += 1;
      prodQty += Math.max(qty, 0);
      prodValue += Math.max(qty, 0) * price;
      if (soldVariantIdsRecently.has(v.id)) prodSoldRecently = true;
      if (lastSold && (!prodLastSold || lastSold > prodLastSold)) prodLastSold = lastSold;
      const base = {
        produto: p.title,
        variacao: v.title && v.title !== "Default Title" ? v.title : "",
        sku: v.sku || "",
        preco: round2(price),
        ultimaVenda: lastSold ? lastSold.slice(0, 10) : null,
        diasSemVender: daysSince,
      };
      if (qty <= 0) {
        stockoutSkuCount += 1;
        stockoutList.push({ ...base, qtd: 0 });
        continue;
      }
      if (!soldVariantIdsRecently.has(v.id)) {
        stalledSkuCount += 1;
        stalledUnits += qty;
        stalledList.push({ ...base, qtd: qty, valorParado: round2(price * qty) });
      } else if (qty <= LOW_STOCK_THRESHOLD) {
        // Vendeu nos últimos 180 dias E está com pouca peça = repor
        lowStockList.push({ ...base, qtd: qty });
      }
    }

    // Produto INTEIRO parado: nenhuma variação vendeu nos últimos 180 dias
    // e ainda sobrou estoque. Candidato a queima/descontinuação.
    if (!prodSoldRecently && prodQty > 0) {
      productStalledList.push({
        produto: p.title,
        variacoes: prodVariants,
        qtd: prodQty,
        valorParado: round2(prodValue),
        ultimaVenda: prodLastSold ? prodLastSold.slice(0, 10) : null,
        diasSemVender: prodLastSold
          ? Math.floor((now - new Date(prodLastSold)) / 86400000)
          : null,
      });
    }
  }
  // Mais dinheiro parado primeiro — é o que interessa pra decidir promoção
  stalledList.sort((a, b) => b.valorParado - a.valorParado);
  stockoutList.sort((a, b) => (a.diasSemVender ?? 99999) - (b.diasSemVender ?? 99999));
  lowStockList.sort((a, b) => a.qtd - b.qtd || (a.diasSemVender ?? 99999) - (b.diasSemVender ?? 99999));
  const stalledValue = round2(stalledList.reduce((s, i) => s + i.valorParado, 0));
  productStalledList.sort((a, b) => b.valorParado - a.valorParado);
  const productStalledValue = round2(productStalledList.reduce((s, i) => s + i.valorParado, 0));

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

  const inPeriod = (o, start, end) => {
    const d = new Date(o.created_at);
    return d >= start && d < end;
  };

  // Calcula todas as métricas de um período específico (start/end) comparado
  // com um período anterior (prevStart/prevEnd) de mesma duração, sobre um
  // conjunto de pedidos (total de vendas OU pagamentos confirmados).
  function computePeriod(orderSet, { start, end, prevStart, prevEnd }) {
    const currentOrders = orderSet.filter((o) => inPeriod(o, start, end));
    const previousOrders = orderSet.filter((o) => inPeriod(o, prevStart, prevEnd));

    const currentRevenue = sum(currentOrders, orderRevenue);
    const previousRevenue = sum(previousOrders, orderRevenue);
    const currentCount = currentOrders.length;
    const previousCount = previousOrders.length;
    const currentAOV = currentCount ? currentRevenue / currentCount : 0;
    const previousAOV = previousCount ? previousRevenue / previousCount : 0;

    // Série diária de receita (para o gráfico de evolução)
    const revenueByDay = {};
    for (const o of currentOrders) {
      const key = dayKey(o.created_at);
      revenueByDay[key] = (revenueByDay[key] || 0) + orderRevenue(o);
    }
    const revenueSeries = Object.keys(revenueByDay)
      .sort()
      .map((date) => ({ date, revenue: round2(revenueByDay[date]) }));

    // Receita e unidades por produto — já com desconto aplicado no item
    const productRevenue = {};
    const productGross = {};
    const productUnits = {};
    let unitsSoldInPeriod = 0;
    for (const o of currentOrders) {
      for (const li of o.line_items || []) {
        const name = li.title || li.name || "Produto";
        const net = lineItemNetRevenue(li);
        productRevenue[name] = (productRevenue[name] || 0) + net;
        productGross[name] = (productGross[name] || 0) + lineItemGrossRevenue(li);
        productUnits[name] = (productUnits[name] || 0) + (li.quantity || 0);
        unitsSoldInPeriod += li.quantity || 0;
      }
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

    // Mais vendidos por QUANTIDADE de peças (diferente do top por receita)
    const topProductsByUnits = Object.entries(productUnits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, units]) => ({
        name,
        units,
        revenue: round2(productRevenue[name] || 0),
        pct: unitsSoldInPeriod ? Math.round((units / unitsSoldInPeriod) * 1000) / 10 : 0,
      }));

    // Margem bruta do período, já considerando desconto por item.
    // Base de "receita total" = soma líquida dos itens (não o total do
    // pedido, que inclui frete e pode ter outras diferenças).
    const totalLineItemsRevenue = sum(Object.values(productRevenue), (v) => v);
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
    const costCoveragePct = totalLineItemsRevenue
      ? Math.round((revenueWithKnownCost / totalLineItemsRevenue) * 1000) / 10
      : 0;

    // Detalhamento para mostrar a "conta" da margem no dashboard.
    // Restrito aos produtos COM custo cadastrado, senão as linhas não fecham.
    let grossWithKnownCost = 0;
    for (const [name, g] of Object.entries(productGross)) {
      if (typeof findUnitCost(name) === "number") grossWithKnownCost += g;
    }

    // Clientes novos vs recompra dentro deste período
    let newCustomers = 0;
    let returningCustomers = 0;
    const seenCustomerIds = new Set();
    for (const o of currentOrders) {
      const c = o.customer;
      if (!c || !c.id) continue;
      if (seenCustomerIds.has(c.id)) continue;
      seenCustomerIds.add(c.id);
      if ((ordersPerCustomer[c.id] || 0) <= 1) newCustomers += 1;
      else returningCustomers += 1;
    }
    const totalIdentifiedCustomers = newCustomers + returningCustomers;
    const recompraPct = totalIdentifiedCustomers
      ? Math.round((returningCustomers / totalIdentifiedCustomers) * 1000) / 10
      : null;

    // Cobertura/giro de estoque, considerando a duração real deste período
    const periodDaysSpan = Math.max((end - start) / (1000 * 60 * 60 * 24), 1);
    const avgDailyUnitsSold = unitsSoldInPeriod / periodDaysSpan;
    const coverageDays = avgDailyUnitsSold > 0 ? Math.round(totalUnits / avgDailyUnitsSold) : null;
    const turnoverRate = totalUnits > 0 ? Math.round((unitsSoldInPeriod / totalUnits) * 100) / 100 : null;

    return {
      period: {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      },
      kpis: {
        revenue: { value: round2(currentRevenue), changePct: pctChange(currentRevenue, previousRevenue) },
        orders: { value: currentCount, changePct: pctChange(currentCount, previousCount) },
        aov: { value: round2(currentAOV), changePct: pctChange(currentAOV, previousAOV) },
      },
      revenueSeries,
      topProducts,
      topProductsByUnits,
      margin: {
        overallMarginPct,
        grossProfit: round2(grossProfitKnown),
        costCoveragePct,
        // A conta, linha a linha (só produtos com custo cadastrado):
        breakdown: {
          grossSales: round2(grossWithKnownCost),
          discounts: round2(grossWithKnownCost - revenueWithKnownCost),
          netSales: round2(revenueWithKnownCost),
          cost: round2(costOfKnownProducts),
          profit: round2(grossProfitKnown),
        },
      },
      customers: { newCustomers, returningCustomers, recompraPct },
      inventoryStats: { coverageDays, turnoverRate },
    };
  }

  // Monta os períodos disponíveis no seletor do dashboard
  const periodsConfig = {
    "7d": { start: daysAgo(now, 7), end: now, prevStart: daysAgo(now, 14), prevEnd: daysAgo(now, 7) },
    "30d": { start: daysAgo(now, 30), end: now, prevStart: daysAgo(now, 60), prevEnd: daysAgo(now, 30) },
    "90d": { start: daysAgo(now, 90), end: now, prevStart: daysAgo(now, 180), prevEnd: daysAgo(now, 90) },
  };
  {
    const cur = calendarMonthRange(now, 0);
    const prev = calendarMonthRange(now, -1);
    periodsConfig["current_month"] = { start: cur.start, end: cur.end, prevStart: prev.start, prevEnd: prev.end };
  }
  {
    const cur = calendarMonthRange(now, -1);
    const prev = calendarMonthRange(now, -2);
    periodsConfig["previous_month"] = { start: cur.start, end: cur.end, prevStart: prev.start, prevEnd: prev.end };
  }

  // Gera todos os períodos nos DOIS modos: "total" (total em vendas, igual
  // ao relatório da Shopify) e "confirmed" (só pagamentos confirmados).
  const periodsByMode = { total: {}, confirmed: {} };
  for (const [key, cfg] of Object.entries(periodsConfig)) {
    periodsByMode.total[key] = computePeriod(allSalesOrders, cfg);
    periodsByMode.confirmed[key] = computePeriod(confirmedOrders, cfg);
  }
  // `periods` mantém o formato antigo (compatibilidade): aponta pro modo "total".
  const periods = periodsByMode.total;

  // Dataset compacto de pedidos. É isso que permite o dashboard calcular
  // QUALQUER intervalo escolhido no calendário, sem rodar o workflow de novo.
  // Nomes de campo curtos de propósito, pra não inchar o data.json:
  //   d = data      t = total do pedido       p = pagamento confirmado (0/1)
  //   c = id do cliente                       r = cliente recorrente (0/1)
  //   li = itens: n = nome, v = receita líquida, q = qtd, c = custo unitário
  const ordersFlat = allSalesOrders.map((o) => {
    const cid = o.customer && o.customer.id ? String(o.customer.id) : null;
    return {
      d: o.created_at,
      t: round2(orderRevenue(o)),
      p: PAID_STATUSES.has(o.financial_status) ? 1 : 0,
      c: cid,
      r: cid && (ordersPerCustomer[cid] || 0) > 1 ? 1 : 0,
      li: (o.line_items || []).map((li) => {
        const name = li.title || li.name || "Produto";
        const unitCost = findUnitCost(name);
        return {
          n: name,
          v: round2(lineItemNetRevenue(li)),
          g: round2(lineItemGrossRevenue(li)),
          q: li.quantity || 0,
          c: typeof unitCost === "number" ? unitCost : null,
        };
      }),
    };
  });
  console.log(`[info] ${ordersFlat.length} pedidos exportados para o seletor de datas personalizado.`);

  // ---- Checkouts abandonados (últimos 90 dias — limite do que a Shopify guarda) ----
  const abandonoDesde = daysAgo(now, 90);
  console.log("Buscando checkouts abandonados...");
  const { ok: abandonoOk, checkouts } = await fetchAbandonedCheckouts(abandonoDesde.toISOString());

  // Só conta como abandonado o que NÃO virou pedido depois (a Shopify marca
  // o checkout recuperado preenchendo completed_at).
  const abandonados = checkouts.filter((c) => !c.completed_at);
  const recuperados = checkouts.filter((c) => c.completed_at);

  // Formato compacto (mesma lógica do ordersFlat): permite calcular qualquer
  // período no dashboard. SEM e-mail, telefone ou link de recuperação — o
  // data.json é público.
  const abandonedFlat = abandonados.map((c) => ({
    d: c.created_at,
    t: round2(parseFloat(c.total_price || "0")),
    li: (c.line_items || []).map((li) => ({
      n: li.title || "Produto",
      q: li.quantity || 0,
    })),
  }));
  const recoveredFlat = recuperados.map((c) => ({
    d: c.created_at,
    t: round2(parseFloat(c.total_price || "0")),
  }));

  if (abandonoOk) {
    console.log(
      `[info] checkouts: ${abandonados.length} abandonados (R$ ${round2(
        abandonedFlat.reduce((s, c) => s + c.t, 0)
      )}) | ${recuperados.length} recuperados`
    );
  }

  // Mapa de clientes (id -> identificação) para montar a lista de quem
  // comprou em cada período. ATENÇÃO: o data.json é público (GitHub Pages),
  // então NÃO exportamos e-mail/telefone completos — só primeiro nome e
  // e-mail mascarado, o suficiente pra reconhecer o cliente. Para campanhas
  // com o dado completo, exporte direto da Shopify (área logada).
  const maskEmail = (email) => {
    if (!email || !email.includes("@")) return null;
    const [user, domain] = email.split("@");
    const visible = user.slice(0, 2);
    return `${visible}${"*".repeat(Math.max(user.length - 2, 1))}@${domain}`;
  };
  const customersMap = {};
  for (const o of confirmedOrders) {
    const c = o.customer;
    if (!c || !c.id) continue;
    const id = String(c.id);
    if (!customersMap[id]) {
      customersMap[id] = {
        nome: [c.first_name, c.last_name ? c.last_name[0] + "." : ""].filter(Boolean).join(" ") || "(sem nome)",
        email: maskEmail(c.email),
      };
    }
  }

  // Metas mensais definidas manualmente em metas.json (opcional).
  // Formato: { "2026-08": 15000, "2026-09": 18000 }
  let metas = {};
  try {
    const fsSync2 = await import("node:fs/promises");
    const rawMetas = await fsSync2.readFile("metas.json", "utf-8");
    const parsedMetas = JSON.parse(rawMetas);
    delete parsedMetas._comentario;
    for (const [k, v] of Object.entries(parsedMetas)) {
      if (/^\d{4}-\d{2}$/.test(k) && typeof v === "number") metas[k] = v;
    }
    if (Object.keys(metas).length) console.log(`[info] ${Object.keys(metas).length} meta(s) mensal(is) carregada(s).`);
  } catch {
    console.log("metas.json não encontrado — a aba Metas usará só as projeções automáticas.");
  }

  const output = {
    updatedAt: now.toISOString(),
    defaultPeriod: "30d",
    defaultRevenueMode: "confirmed",
    // periodsByMode.total     -> "Total em vendas" (mesma lógica do relatório da Shopify)
    // periodsByMode.confirmed -> "Pagamentos confirmados" (dinheiro que realmente entrou)
    periodsByMode,
    periods,
    ordersFlat,
    customersMap,
    metas,
    checkout: {
      disponivel: abandonoOk,
      desde: abandonoDesde.toISOString().slice(0, 10),
      abandonedFlat,
      recoveredFlat,
    },
    inventory: {
      totalUnits,
      stalledSkuCount,
      stalledUnits,
      stalledValue,
      stockoutSkuCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      lowStockCount: lowStockList.length,
      lowStockList,
      stalledList,
      productStalledCount: productStalledList.length,
      productStalledValue,
      productStalledList,
      stockoutList,
    },
    // Espelhos de compatibilidade: os scripts fetch-meta-ads.mjs e
    // compute-alerts.mjs (e qualquer versão antiga do dashboard) leem os
    // dados do período de 30 dias direto na raiz do JSON.
    kpis: periods["30d"].kpis,
    revenueSeries: periods["30d"].revenueSeries,
    topProducts: periods["30d"].topProducts,
    customers: periods["30d"].customers,
    margin: periods["30d"].margin,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile("data.json", JSON.stringify(output, null, 2));
  console.log("data.json gerado com sucesso.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
