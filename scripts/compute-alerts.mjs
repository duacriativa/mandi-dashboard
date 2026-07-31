// scripts/compute-alerts.mjs
//
// Lê o data.json já gerado (por fetch-shopify.mjs e, se configurado,
// fetch-meta-ads.mjs) e adiciona uma lista de alertas com regras simples.
// Roda por último no workflow, sem precisar de nenhuma API externa.
//
// Rodar localmente:
//   node scripts/compute-alerts.mjs

import { readFile, writeFile } from "node:fs/promises";

function fmtPct(n) {
  return Math.abs(n).toFixed(1).replace(".", ",") + "%";
}

async function main() {
  const raw = await readFile("data.json", "utf-8");
  const data = JSON.parse(raw);

  const alerts = [];

  // Receita
  const revenueChange = data.kpis?.revenue?.changePct;
  if (revenueChange !== null && revenueChange !== undefined) {
    if (revenueChange <= -5) {
      alerts.push({ type: "bad", text: `Receita caiu ${fmtPct(revenueChange)} em relação ao período anterior.` });
    } else if (revenueChange >= 10) {
      alerts.push({ type: "good", text: `Receita subiu ${fmtPct(revenueChange)} em relação ao período anterior.` });
    }
  }

  // Ticket médio
  const aovChange = data.kpis?.aov?.changePct;
  if (aovChange !== null && aovChange !== undefined) {
    if (aovChange <= -5) {
      alerts.push({ type: "bad", text: `Ticket médio caiu ${fmtPct(aovChange)} em relação ao período anterior.` });
    } else if (aovChange >= 10) {
      alerts.push({ type: "good", text: `Ticket médio subiu ${fmtPct(aovChange)} em relação ao período anterior.` });
    }
  }

  // Estoque parado / ruptura
  const inv = data.inventory || {};
  if (inv.stalledSkuCount > 0) {
    alerts.push({
      type: "warning",
      text: `${inv.stalledSkuCount} produto(s) parado(s) há mais de 180 dias sem vender (${inv.stalledUnits || 0} peças).`,
    });
  }
  if (inv.stockoutSkuCount > 0) {
    alerts.push({
      type: "warning",
      text: `${inv.stockoutSkuCount} produto(s) em ruptura de estoque.`,
    });
  }
  if (inv.coverageDays !== null && inv.coverageDays !== undefined && inv.coverageDays < 15) {
    alerts.push({
      type: "warning",
      text: `Cobertura de estoque baixa: apenas ${inv.coverageDays} dias de venda no ritmo atual.`,
    });
  }

  // Clientes / recompra
  const recompraPct = data.customers?.recompraPct;
  if (recompraPct !== null && recompraPct !== undefined) {
    if (recompraPct < 15) {
      alerts.push({ type: "warning", text: `Taxa de recompra baixa: só ${recompraPct.toFixed(1).replace(".", ",")}% dos pedidos são de clientes recorrentes.` });
    } else if (recompraPct > 40) {
      alerts.push({ type: "good", text: `Boa taxa de recompra: ${recompraPct.toFixed(1).replace(".", ",")}% dos pedidos são de clientes recorrentes.` });
    }
  }

  // Margem
  const margin = data.margin;
  if (margin && margin.overallMarginPct !== null && margin.overallMarginPct !== undefined) {
    if (margin.overallMarginPct < 30) {
      alerts.push({ type: "bad", text: `Margem bruta baixa: ${margin.overallMarginPct.toFixed(1).replace(".", ",")}% (sobre ${margin.costCoveragePct?.toFixed(0) ?? 0}% da receita com custo cadastrado).` });
    } else if (margin.overallMarginPct >= 50) {
      alerts.push({ type: "good", text: `Boa margem bruta: ${margin.overallMarginPct.toFixed(1).replace(".", ",")}%.` });
    }
  }

  // Marketing (Meta Ads), se configurado
  if (data.marketing) {
    const { roas, spend } = data.marketing;
    if (roas !== null && roas !== undefined) {
      if (roas >= 3) {
        alerts.push({ type: "good", text: `ROAS de ${roas.toFixed(1).replace(".", ",")}x nos últimos 30 dias.` });
      } else if (roas < 1.5 && spend > 0) {
        alerts.push({ type: "bad", text: `ROAS baixo (${roas.toFixed(1).replace(".", ",")}x): o investimento em anúncios pode não estar retornando bem.` });
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
