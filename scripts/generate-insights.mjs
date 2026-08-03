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
function montarResumo(data, historicoAcoes) {
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

  // NOTA: dados de tráfego pago (campanhas, ROAS) ficam FORA da análise de
  // propósito. Campanhas têm objetivos diferentes (engajamento, alcance,
  // conversão) e julgá-las todas pela régua de ROAS de compra gera
  // conclusões erradas — a gestão de tráfego é análise à parte.

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

  // Instagram ORGÂNICO (seguidores, formatos, top posts). Análise de
  // conteúdo orgânico é permitida — a proibição vale só para campanhas pagas.
  const ig = data.instagram;
  const instagramOrganico = ig?.disponivel
    ? {
        seguidores: ig.seguidores,
        novosSeguidores30d: ig.novosSeguidores30d,
        visualizacoes30d: ig.visualizacoes,
        alcance30d: ig.alcance,
        interacoes30d: ig.interacoes,
        cliquesNoLink30d: ig.cliquesLink,
        desempenhoPorFormato: ig.porFormato,
        top5Posts: (ig.topPosts || []).map((p) => ({
          tipo: p.tipo, views: p.views, legenda: p.legenda,
        })),
      }
    : null;

  return {
    hoje: new Date().toISOString().slice(0, 10),
    datasComerciaisProximas: proximasDatasComerciais(new Date()),
    instagramOrganico,
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
    acoesJaExecutadas: historicoAcoes,
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
      "categoria": "vendas" | "estoque" | "checkout" | "clientes" | "margem",
      "porque": "1 frase com o número que justifica (R$, %, qtd)",
      "como": "a execução DECIDIDA: mecânica, valores e canal escolhidos, em 2-4 frases"
    }
  ],
  "cronograma": [
    { "data": "YYYY-MM-DD", "titulo": "o que fazer nesse dia (máx 60 chars)", "detalhe": "1-2 frases práticas" }
  ]
}

REGRAS DE ESTILO — as mais importantes:
- DECIDA TUDO. Nunca escreva "considere", "avalie", "pode ser interessante" ou termine com pergunta. Escolha o desconto, o canal, o público e o valor — e afirme. Se faltar informação, assuma a premissa mais provável e diga qual assumiu ("assumindo margem média de 55%...").
- PROIBIDO analisar, citar ou julgar campanhas de tráfego pago / Meta Ads / anúncios. Isso é gerido por outra equipe com objetivos próprios (engajamento, alcance, conversão) e não faz parte desta análise. Nunca use palavras como "prejuízo" sobre investimento em anúncios. As ações podem PRESSUPOR divulgação ("divulgue no Instagram e para a base"), mas sem opinar sobre campanhas existentes. Conteúdo ORGÂNICO do Instagram (campo instagramOrganico) PODE e DEVE ser analisado: formatos que performam, temas dos posts campeões, crescimento de seguidores — use isso nas ações e na pauta de stories.
- Se houver data comercial próxima (campo datasComerciaisProximas), a ação nº 1 deve ser uma campanha ancorada nela, com: tema, oferta exata (ex: "20% off ou frete grátis acima de R$200"), produtos escolhidos pelos dados, público e canal orgânico/CRM. Inclua uma sugestão de texto pronta, entre aspas, que a loja possa copiar.
- Considere acoesJaExecutadas: NÃO sugira de novo o que já foi feito — construa em cima ("como a liquidação começou dia X, agora..."). Se uma ação executada pede acompanhamento, inclua o acompanhamento no cronograma.
- CRONOGRAMA: distribua as ações (e seus acompanhamentos) em datas concretas dos próximos 14 dias, na ordem que faz sentido comercial. 5 a 10 entradas. Cada dia com tarefa objetiva ("subir os banners", "disparar o e-mail", "revisar o giro da liquidação").
- Máximo de 5 ações. Cite produtos PELO NOME ("as 38 peças da Camiseta Vintage Azul"), nunca genérico.
- Chame de "checkouts abandonados" (não "carrinhos") — são estágios diferentes do funil.
- Produto 100% parado → promoção com % compatível com a margem informada. Variação zerada que vendia → reposição com prazo.
- Português do Brasil, tom direto de sócio experiente, zero enrolação.`;

async function chamarClaude(resumo, promptExtra = "") {
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
      system: PROMPT_SISTEMA + promptExtra,
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

  // Histórico de ações que a loja registrou em acoes.json (mesmo padrão do
  // custos.json: arquivo editável à mão no repositório). Opcional.
  let historicoAcoes = [];
  try {
    const rawAcoes = await readFile("acoes.json", "utf-8");
    const parsedAcoes = JSON.parse(rawAcoes);
    historicoAcoes = (parsedAcoes.historico || [])
      .filter((a) => a && a.acao)
      .slice(-30); // as 30 mais recentes bastam
    if (historicoAcoes.length) console.log(`[info] ${historicoAcoes.length} ação(ões) registradas em acoes.json.`);
  } catch {
    console.log("acoes.json não encontrado — seguindo sem histórico de ações.");
  }

  const resumo = montarResumo(data, historicoAcoes);

  // Pauta de stories: gerada só às SEGUNDAS, cobrindo de quarta a terça.
  // Nos outros dias, a pauta da última segunda é preservada (ver adiante).
  const hoje = new Date();
  const ehSegunda = hoje.getUTCDay() === 1;
  let promptExtra = "";
  if (ehSegunda) {
    const dias = [];
    const NOMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    for (let i = 2; i <= 8; i++) {
      const d = new Date(hoje);
      d.setUTCDate(d.getUTCDate() + i);
      dias.push(`${d.toISOString().slice(0, 10)} (${NOMES[d.getUTCDay()]})`);
    }
    promptExtra = `

PAUTA DE STORIES (só hoje, segunda-feira): inclua também no JSON o campo:
"pautaStories": [ { "dia": "YYYY-MM-DD", "diaSemana": "quarta", "tema": "tópico curto" } ]
- Um tema por dia, para estes 7 dias exatos: ${dias.join(", ")}.
- APENAS o tópico sugestivo (máx 90 caracteres), não o roteiro — ex: "Bastidor da separação dos pedidos da campanha", "Prova social: print de cliente com a Pima Goiaba", "Contagem regressiva: último dia do frete grátis".
- Baseie os temas nos DADOS: produtos campeões, campanha da data comercial, liquidação em andamento, peças que voltaram ao estoque, produtos mais abandonados no checkout (mostrar eles em uso ajuda a converter).
- Varie os formatos ao longo da semana: produto, bastidor, prova social, oferta, enquete/interação.`;
  }
  console.log(`Pedindo análise ao Claude (${MODEL})... (~${Math.round(JSON.stringify(resumo).length / 1024)} KB de dados)`);

  try {
    const analise = await chamarClaude(resumo, promptExtra);

    // Pauta: nova às segundas; nos demais dias, carrega a da última segunda
    // (expira depois de 8 dias pra nunca mostrar semana velha).
    const anterior = data.insights?.pautaStories;
    const anteriorEm = data.insights?.pautaGeradaEm;
    let pautaStories = null;
    let pautaGeradaEm = null;
    if (ehSegunda && Array.isArray(analise.pautaStories) && analise.pautaStories.length) {
      pautaStories = analise.pautaStories;
      pautaGeradaEm = new Date().toISOString();
    } else if (anterior && anteriorEm && (Date.now() - new Date(anteriorEm)) < 8 * 86400000) {
      pautaStories = anterior;
      pautaGeradaEm = anteriorEm;
    }

    data.insights = {
      disponivel: true,
      geradoEm: new Date().toISOString(),
      modelo: MODEL,
      diagnostico: analise.diagnostico,
      acoes: analise.acoes,
      cronograma: Array.isArray(analise.cronograma) ? analise.cronograma : [],
      ...(pautaStories ? { pautaStories, pautaGeradaEm } : {}),
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
