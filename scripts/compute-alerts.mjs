// scripts/compute-alerts.mjs
//
// Lê o data.json já gerado (por fetch-shopify.mjs e, se configurado,
// fetch-meta-ads.mjs) e adiciona uma lista de alertas com regras simples.
// Roda por último no workflow, sem precisar de nenhuma API externa.
//
// BASE DE CÁLCULO: os alertas usam os últimos 30 dias no modo "pagamentos
// confirmados" (dinheiro que realmente entrou), que é o padrão do dashboard.
// Assim o alerta não diz uma coisa e o painel mostra outra.
//
// Rodar localmente:
//   node scripts/compute-alerts.mjs

import { readFile, writeFile } from "node:fs/promises";

const pct = (n) => Math.abs(n).toFixed(1).replace(".", ",") + "%";
const num = (n) => (n ?? 0).toLocaleString("pt-BR");
const brl = (n) =>
  (n ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const data = JSON.parse(await readFile("data.json", "utf-8"));
  const alerts = [];

  // Prefere o modo "pagamentos confirmados"; cai para o formato antigo se
  // o data.json ainda não tiver periodsByMode.
  const p =
    data.periodsByMode?.confirmed?.["30d"] ||
    data.periods?.["30d"] || {
      kpis: data.kpis,
      customers: data.customers,
      margin: data.margin,
      inventoryStats: {},
    };

  // ---- Receita ----
  const revenueChange = p.kpis?.revenue?.changePct;
  if (revenueChange !== null && revenueChange !== undefined) {
    if (revenueChange <= -5) {
      alerts.push({ type: "bad", text: `Receita caiu ${pct(revenueChange)} em relação ao período anterior.` });
    } else if (revenueChange >= 10) {
      alerts.push({ type: "good", text: `Receita subiu ${pct(revenueChange)} em relação ao período anterior.` });
    }
  }

  // ---- Ticket médio ----
  const aovChange = p.kpis?.aov?.changePct;
  if (aovChange !== null && aovChange !== undefined) {
    if (aovChange <= -5) {
      alerts.push({ type: "bad", text: `Ticket médio caiu ${pct(aovChange)} em relação ao período anterior.` });
    } else if (aovChange >= 10) {
      alerts.push({ type: "good", text: `Ticket médio subiu ${pct(aovChange)} em relação ao período anterior.` });
    }
  }

  // ---- Estoque ----
  // Atenção à diferença: VARIAÇÃO é um tamanho/cor específico; PRODUTO é a
  // peça inteira. O texto antigo dizia "produtos" para contagens que eram
  // de variação, o que inflava muito o número.
  const inv = data.inventory || {};

  if (inv.productStalledCount > 0) {
    const valor = inv.productStalledValue ? ` — ${brl(inv.productStalledValue)} parados` : "";
    alerts.push({
      type: "warning",
      text: `${inv.productStalledCount} produto(s) sem vender nenhuma variação há mais de 180 dias${valor}. Candidatos a promoção.`,
    });
  } else if (inv.stalledSkuCount > 0) {
    alerts.push({
      type: "warning",
      text: `${inv.stalledSkuCount} variação(ões) parada(s) há mais de 180 dias (${num(inv.stalledUnits)} peças).`,
    });
  }

  if (inv.lowStockCount > 0) {
    alerts.push({
      type: "warning",
      text: `${inv.lowStockCount} variação(ões) vendendo bem e com ${inv.lowStockThreshold ?? 3} peças ou menos. Repor antes de zerar.`,
    });
  }

  if (inv.stockoutSkuCount > 0) {
    alerts.push({
      type: "warning",
      text: `${inv.stockoutSkuCount} variação(ões) (tamanho/cor) com estoque zerado — o produto segue à venda, mas essas opções não podem ser compradas.`,
    });
  }

  // Cobertura de estoque: no data.json isso vive em inventoryStats do
  // período, não em inventory. (A versão anterior lia do lugar errado e
  // este alerta nunca aparecia.)
  const coverageDays = p.inventoryStats?.coverageDays;
  if (coverageDays !== null && coverageDays !== undefined && coverageDays < 15) {
    alerts.push({
      type: "warning",
      text: `Cobertura de estoque baixa: apenas ${coverageDays} dias de venda no ritmo atual.`,
    });
  }

  // ---- Clientes / recompra ----
  const recompraPct = p.customers?.recompraPct;
  if (recompraPct !== null && recompraPct !== undefined) {
    if (recompraPct < 15) {
      alerts.push({ type: "warning", text: `Taxa de recompra baixa: só ${pct(recompraPct)} dos clientes do período já haviam comprado antes.` });
    } else if (recompraPct > 40) {
      alerts.push({ type: "good", text: `Boa taxa de recompra: ${pct(recompraPct)} dos clientes do período já haviam comprado antes.` });
    }
  }

  // ---- Margem ----
  const margin = p.margin;
  if (margin && margin.overallMarginPct !== null && margin.overallMarginPct !== undefined) {
    const cobertura = margin.costCoveragePct ?? 0;
    if (margin.overallMarginPct < 30) {
      alerts.push({ type: "bad", text: `Margem bruta baixa: ${pct(margin.overallMarginPct)} (calculada sobre ${cobertura.toFixed(0)}% da receita, que é a parte com custo cadastrado).` });
    } else if (margin.overallMarginPct >= 50) {
      alerts.push({ type: "good", text: `Boa margem bruta: ${pct(margin.overallMarginPct)} — não inclui frete, taxas de pagamento nem impostos.` });
    }
  }

  // ---- Checkout abandonado ----
  const ck = data.checkout;
  if (ck?.disponivel && Array.isArray(ck.abandonedFlat)) {
    const inicio = new Date();
    inicio.setDate(inicio.getDate() - 30);
    const corte = inicio.toISOString().slice(0, 10);
    const recentes = ck.abandonedFlat.filter((c) => c.d.slice(0, 10) >= corte);
    const valor = recentes.reduce((s, c) => s + (c.t || 0), 0);
    const pedidos = p.kpis?.orders?.value || 0;
    const iniciados = recentes.length + pedidos;
    const taxa = iniciados ? (recentes.length / iniciados) * 100 : 0;

    if (recentes.length > 0 && taxa >= 50) {
      alerts.push({
        type: "bad",
        text: `${taxa.toFixed(0)}% dos checkouts iniciados foram abandonados (${recentes.length}), deixando ${brl(valor)} pelo caminho.`,
      });
    } else if (recentes.length > 0) {
      alerts.push({
        type: "warning",
        text: `${recentes.length} checkout(s) abandonado(s) nos últimos 30 dias, somando ${brl(valor)}.`,
      });
    }
  }

  // ---- Marketing (Meta Ads), se configurado ----
  if (data.marketing) {
    const m = data.marketing;

    // ROAS pela receita da loja (otimista: inclui venda orgânica)
    if (m.roas !== null && m.roas !== undefined && m.spend > 0) {
      if (m.roas >= 3) {
        alerts.push({ type: "good", text: `ROAS de ${m.roas.toFixed(1).replace(".", ",")}x nos últimos 30 dias — receita TOTAL da loja ÷ investimento, então inclui vendas que não vieram do anúncio.` });
      } else if (m.roas < 1.5) {
        alerts.push({ type: "bad", text: `ROAS baixo (${m.roas.toFixed(1).replace(".", ",")}x): mesmo contando a receita total da loja, o investimento em anúncios está retornando pouco.` });
      }
    }

    // ROAS atribuído pelo Meta (o que o pixel credita aos anúncios)
    if (Array.isArray(m.dailyAds) && m.dailyAds.length) {
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - 30);
      const corte = inicio.toISOString().slice(0, 10);
      const janela = m.dailyAds.filter((d) => d.date >= corte);
      const gasto = janela.reduce((s, d) => s + (d.spend || 0), 0);
      const receitaMeta = janela.reduce((s, d) => s + (d.metaRevenue || 0), 0);
      if (gasto > 0) {
        const roasMeta = receitaMeta / gasto;
        const tipo = roasMeta >= 2 ? "good" : roasMeta < 1 ? "bad" : "warning";
        alerts.push({
          type: tipo,
          text: `ROAS atribuído pelo Meta: ${roasMeta.toFixed(1).replace(".", ",")}x (${brl(receitaMeta)} de venda creditada a ${brl(gasto)} investidos). É a leitura mais conservadora.`,
        });
      }
    }
  }

  if (alerts.length === 0) {
    alerts.push({ type: "good", text: "Nenhum ponto de atenção identificado neste período." });
  }

  data.alerts = alerts;
  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log(`data.json atualizado com ${alerts.length} alerta(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
