// scripts/generate-insights.mjs
//
// Lê o data.json já completo (Shopify + Meta + alertas) e pede ao Claude
// (API da Anthropic) uma análise comercial com ações sugeridas. O resultado
// é salvo em data.insights e exibido na aba "Análise IA" do dashboard.
//
// Roda por ÚLTIMO no workflow (depois do compute-alerts.mjs).
//
// Variável de ambiente necessária:
//   ANTHROPIC_API_KEY -> chave criada em console.anthropic.com
//
// Se a chave não existir ou a chamada falhar, o script mantém a análise
// anterior (se houver) e NUNCA derruba o workflow — a análise é um extra,
// não pode custar a atualização dos dados de venda.

import { readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
// claude-sonnet-5 (jun/2026): melhor e mais barato que o 4.6 anterior.
// Se um dia der erro de modelo inexistente, confira o ID atual em
// platform.claude.com/docs -> Models.
const MODEL = "claude-sonnet-5";

const round2 = (n) => Math.round((n ?? 0) * 100) / 100;

// Monta um resumo COMPACTO dos dados. Não mandamos o data.json inteiro:
// ordersFlat e as séries diárias têm milhares de linhas que só encareceriam
// a chamada sem melhorar a análise. Também não mandamos nomes de clientes.
function montarResumo(data) {
  const m = (modo, chave) => data.periodsByMode?.[modo]?.[chave] || null;
  const fmtPeriodo = (p) =>
    p && {
      periodo: `${p.period.start} a ${p.period.end}`,
      receita: p.kpis.revenue.value,
      variacaoReceitaPct: round2(p.kpis.revenue.changePct),
      pedidos: p.kpis.orders.value,
      variacaoPedidosPct: round2(p.kpis.orders.changePct),
      ticketMedio: p.kpis.aov.value,
      variacaoTicketPct: round2(p.kpis.aov.changePct),
      clientesNovos: p.customers?.newCustomers,
      clientesRecorrentes: p.customers?.returningCustomers,
      recompraPct: p.customers?.recompraPct,
      margemBrutaPct: p.margin?.overallMarginPct,
      contaMargem: p.margin?.breakdown,
      coberturaEstoqueDias: p.inventoryStats?.coverageDays,
      topProdutosPorReceita: (p.topProducts || []).slice(0, 5),
      topProdutosPorPecas: (p.topProductsByUnits || []).slice(0, 5),
    };

  const inv = data.inventory || {};
  const ck = data.checkout || {};
  const mk = data.marketing || {};

  // Meta Ads: agrega os últimos 30 dias e as 8 campanhas com mais gasto
  let ads = null;
  if (Array.isArray(mk.dailyAds) && mk.dailyAds.length) {
    const corte = new Date();
    corte.setDate(corte.getDate() - 30);
    const c = corte.toISOString().slice(0, 10);
    const janela = mk.dailyAds.filter((d) => d.date >= c);
    const gasto = round2(janela.reduce((s, d) => s + (d.spend || 0), 0));
    const receitaMeta = round2(janela.reduce((s, d) => s + (d.metaRevenue || 0), 0));
    const porCampanha = {};
    for (const r of mk.dailyByCampaign || []) {
      if (r.d < c) continue;
      if (!porCampanha[r.id]) porCampanha[r.id] = { gasto: 0, receitaMeta: 0, compras: 0 };
      porCampanha[r.id].gasto += r.s || 0;
      porCampanha[r.id].receitaMeta += r.v || 0;
      porCampanha[r.id].compras += r.c || 0;
    }
    const nomes = Object.fromEntries((mk.campaigns || []).map((cp) => [cp.id, cp]));
    ads = {
      investimento30d: gasto,
      roasAtribuidoMeta: gasto ? round2(receitaMeta / gasto) : null,
      campanhas: Object.entries(porCampanha)
        .sort((a, b) => b[1].gasto - a[1].gasto)
        .slice(0, 8)
        .map(([id, v]) => ({
          nome: nomes[id]?.name || id,
          status: nomes[id]?.status || "?",
          gasto: round2(v.gasto),
          comprasAtribuidas: v.compras,
          roasMeta: v.gasto ? round2(v.receitaMeta / v.gasto) : null,
        })),
    };
  }

  // Checkout abandonado: últimos 30 dias
  let checkout = null;
  if (ck.disponivel && Array.isArray(ck.abandonedFlat)) {
    const corte = new Date();
    corte.setDate(corte.getDate() - 30);
    const c = corte.toISOString().slice(0, 10);
    const rec = ck.abandonedFlat.filter((x) => x.d.slice(0, 10) >= c);
    const produtos = {};
    for (const a of rec)
      for (const li of a.li || []) produtos[li.n] = (produtos[li.n] || 0) + 1;
    checkout = {
      abandonados30d: rec.length,
      valorAbandonado30d: round2(rec.reduce((s, x) => s + x.t, 0)),
      produtosMaisAbandonados: Object.entries(produtos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, v]) => `${n} (${v}x)`),
    };
  }

  return {
    hoje: new Date().toISOString().slice(0, 10),
    vendasConfirmadas: {
      ultimos7dias: fmtPeriodo(m("confirmed", "7d")),
      ultimos30dias: fmtPeriodo(m("confirmed", "30d")),
      mesAtual: fmtPeriodo(m("confirmed", "current_month")),
    },
    estoque: {
      totalPecas: inv.totalUnits,
      produtos100PctParados: inv.productStalledCount,
      valorParadoNessesProdutos: inv.productStalledValue,
      top10ProdutosParados: (inv.productStalledList || []).slice(0, 10),
      variacoesZeradas: inv.stockoutSkuCount,
      top10VariacoesZeradasQueVendiam: (inv.stockoutList || []).slice(0, 10),
      variacoesEstoqueBaixo: inv.lowStockCount,
      top10EstoqueBaixo: (inv.lowStockList || []).slice(0, 10),
    },
    checkoutAbandonado: checkout,
    trafegoPago: ads,
    alertasAtuais: (data.alerts || []).map((a) => a.text),
  };
}

const PROMPT_SISTEMA = `Você é um consultor comercial sênior de e-commerce de moda no Brasil. Analise os dados da loja e produza recomendações ACIONÁVEIS.

Responda APENAS com JSON válido, sem markdown, sem cercas de código, neste formato exato:
{
  "diagnostico": "2-4 frases resumindo a situação atual da loja, direto ao ponto",
  "acoes": [
    {
      "titulo": "ação curta e imperativa (máx 60 caracteres)",
      "prioridade": "alta" | "media" | "baixa",
      "categoria": "vendas" | "estoque" | "trafego" | "checkout" | "clientes" | "margem",
      "porque": "1-2 frases: qual dado justifica esta ação",
      "como": "2-4 frases: passos práticos para executar"
    }
  ]
}

Regras:
- 4 a 7 ações, ordenadas por prioridade (alta primeiro)
- Cite números concretos dos dados na justificativa (R$, %, quantidades)
- Prefira ações específicas ("promova as camisetas X que têm R$Y parados") a genéricas ("melhore o marketing")
- ROAS: o atribuído pelo Meta é a leitura conservadora; o da loja inteira é otimista. Considere os dois.
- Estoque: produto 100% parado é candidato a promoção; variação zerada que vendia é reposição urgente
- Se a taxa de recompra for baixa, considere ações de retenção/CRM
- Escreva em português do Brasil, tom direto de consultor, sem bajulação`;

async function chamarClaude(resumo) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: PROMPT_SISTEMA,
      messages: [
        {
          role: "user",
          content: `Dados da loja (JSON):\n${JSON.stringify(resumo, null, 1)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const texto = await res.text();
    if (res.status === 401) throw new Error(`Chave da API inválida (401). Confira o secret ANTHROPIC_API_KEY. ${texto.slice(0, 200)}`);
    if (res.status === 400 && texto.includes("credit")) throw new Error(`Sem créditos na conta da Anthropic. Adicione créditos em console.anthropic.com. ${texto.slice(0, 200)}`);
    throw new Error(`API da Anthropic retornou ${res.status}: ${texto.slice(0, 300)}`);
  }

  const data = await res.json();
  const textoResposta = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Remove cercas de código caso o modelo desobedeça o formato
  const limpo = textoResposta.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(limpo);

  if (!parsed.diagnostico || !Array.isArray(parsed.acoes)) {
    throw new Error("Resposta da IA veio em formato inesperado.");
  }
  return parsed;
}

async function main() {
  const data = JSON.parse(await readFile("data.json", "utf-8"));

  if (!API_KEY) {
    console.log("[aviso] ANTHROPIC_API_KEY não configurada — pulando a análise de IA. O restante do dashboard segue normal.");
    if (!data.insights) {
      data.insights = { disponivel: false, motivo: "Configure o secret ANTHROPIC_API_KEY para habilitar a análise." };
      await writeFile("data.json", JSON.stringify(data, null, 2));
    }
    return;
  }

  const resumo = montarResumo(data);
  console.log(`Pedindo análise ao Claude (${MODEL})... (~${Math.round(JSON.stringify(resumo).length / 1024)} KB de dados)`);

  try {
    const analise = await chamarClaude(resumo);
    data.insights = {
      disponivel: true,
      geradoEm: new Date().toISOString(),
      modelo: MODEL,
      diagnostico: analise.diagnostico,
      acoes: analise.acoes,
    };
    console.log(`Análise gerada: ${analise.acoes.length} ação(ões) sugerida(s).`);
  } catch (err) {
    console.log(`[aviso] Falha ao gerar análise: ${err.message}`);
    if (data.insights?.disponivel) {
      console.log("[aviso] Mantendo a análise anterior no dashboard.");
      data.insights.avisoDesatualizada = `Tentativa de atualização falhou em ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`;
    } else {
      data.insights = { disponivel: false, motivo: `Falha ao gerar: ${err.message.slice(0, 200)}` };
    }
  }

  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log("data.json atualizado.");
}

main().catch((err) => {
  // Nunca derruba o workflow: análise é complementar
  console.error(`[aviso] Erro inesperado na análise de IA: ${err.message}`);
  process.exit(0);
});
