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

// Datas comerciais do varejo brasileiro nos próximos 60 dias — pra IA
// conseguir sugerir campanha com antecedência ("o Dia dos Pais é em X").
function proximasDatasComerciais(hoje) {
  const segundoDomingo = (ano, mes) => {
    const d = new Date(Date.UTC(ano, mes, 1));
    const dow = d.getUTCDay();
    return new Date(Date.UTC(ano, mes, (dow === 0 ? 1 : 8 - dow) + 7));
  };
  const ultimaSexta = (ano, mes) => {
    const d = new Date(Date.UTC(ano, mes + 1, 0));
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  };
  const lista = [];
  for (const ano of [hoje.getUTCFullYear(), hoje.getUTCFullYear() + 1]) {
    lista.push(["Dia do Consumidor", new Date(Date.UTC(ano, 2, 15))]);
    lista.push(["Dia das Mães", segundoDomingo(ano, 4)]);
    lista.push(["Dia dos Namorados", new Date(Date.UTC(ano, 5, 12))]);
    lista.push(["Dia dos Pais", segundoDomingo(ano, 7)]);
    lista.push(["Semana do Brasil", new Date(Date.UTC(ano, 8, 5))]);
    lista.push(["Dia do Cliente", new Date(Date.UTC(ano, 8, 15))]);
    lista.push(["Dia das Crianças", new Date(Date.UTC(ano, 9, 12))]);
    lista.push(["Black Friday", ultimaSexta(ano, 10)]);
    lista.push(["Natal", new Date(Date.UTC(ano, 11, 25))]);
  }
  const limite = new Date(hoje);
  limite.setUTCDate(limite.getUTCDate() + 60);
  return lista
    .filter(([, d]) => d >= hoje && d <= limite)
    .sort((a, b) => a[1] - b[1])
    .map(([nome, d]) => `${nome} (${d.toISOString().slice(0, 10)})`);
}

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
    datasComerciaisProximas: proximasDatasComerciais(new Date()),
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

const PROMPT_SISTEMA = `Você é um consultor comercial sênior de e-commerce de moda no Brasil. Analise os dados e produza um PLANO DE AÇÃO pronto para executar — não um relatório.

Responda APENAS com JSON válido, sem markdown, sem cercas de código, neste formato exato:
{
  "diagnostico": "no máximo 2 frases sobre a situação atual",
  "acoes": [
    {
      "titulo": "ação curta e imperativa (máx 60 caracteres)",
      "prioridade": "alta" | "media" | "baixa",
      "categoria": "vendas" | "estoque" | "trafego" | "checkout" | "clientes" | "margem",
      "porque": "1 frase com o número que justifica (R$, %, qtd)",
      "como": "a execução DECIDIDA: mecânica, valores e canal escolhidos, em 2-4 frases"
    }
  ]
}

REGRAS DE ESTILO — as mais importantes:
- DECIDA TUDO. Nunca escreva "considere", "avalie", "pode ser interessante" ou termine com pergunta. Escolha o desconto, o canal, o público e o valor — e afirme. Se faltar informação, assuma a premissa mais provável e diga qual assumiu ("assumindo margem média de 55%...").
- Se houver data comercial próxima (campo datasComerciaisProximas), a ação nº 1 deve ser uma campanha ancorada nela, com: tema, oferta exata (ex: "20% off ou frete grátis acima de R$200"), produtos escolhidos pelos dados, público e canal. Inclua uma sugestão de texto pronta, entre aspas, que a loja possa copiar (ex: post ou e-mail de 1-2 frases).
- Máximo de 5 ações. Menos e melhor decidido vale mais que muito e vago.
- Cite produtos PELO NOME quando os dados permitirem ("as 38 peças da Camiseta Vintage Azul"), nunca "os produtos parados" genérico.
- ROAS atribuído pelo Meta = leitura conservadora; ROAS da loja = otimista. Use o conservador para decidir corte e o otimista só como teto.
- Produto 100% parado → promoção com % sugerido compatível com a margem informada. Variação zerada que vendia → reposição com prazo ("pedir ao fornecedor esta semana").
- Português do Brasil, tom direto de sócio experiente, zero enrolação.`;

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
      // Folga generosa: modelos com raciocínio adaptativo consomem parte
      // do limite de saída "pensando" antes de responder. Com limite
      // apertado, o JSON final sai cortado no meio.
      max_tokens: 8000,
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

  if (data.stop_reason === "max_tokens") {
    throw new Error("Resposta cortada por limite de tokens — aumente max_tokens no script.");
  }

  const textoResposta = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!textoResposta.trim()) {
    throw new Error(`Resposta sem bloco de texto. Blocos recebidos: ${(data.content || []).map((b) => b.type).join(", ") || "nenhum"}`);
  }

  // Extrai o objeto JSON mesmo que venha com cercas de código ou texto em volta
  const limpo = textoResposta.replace(/```json|```/g, "").trim();
  const ini = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (ini === -1 || fim <= ini) {
    throw new Error(`Resposta não contém JSON. Início do texto: "${limpo.slice(0, 150)}"`);
  }

  let parsed;
  try {
    parsed = JSON.parse(limpo.slice(ini, fim + 1));
  } catch (e) {
    throw new Error(`JSON inválido na resposta (${e.message}). Fim do texto: "...${limpo.slice(-150)}"`);
  }

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
