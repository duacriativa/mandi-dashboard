// scripts/fetch-instagram.mjs
//
// Busca dados do perfil do Instagram via Instagram Graph API e mescla em
// data.instagram no data.json. Usa o MESMO token da Meta (META_ACCESS_TOKEN),
// com as permissões: instagram_basic, instagram_manage_insights,
// pages_read_engagement — e a Página do Facebook atribuída ao system user.
//
// O que sai daqui: seguidores e crescimento (30d), visualizações/alcance/
// interações/cliques no link com comparação ao período anterior, desempenho
// por formato (Reels x Carrossel), demografia e top posts.
// Cada bloco é tolerante a falha: o que não vier, não derruba o resto.

import { readFile, writeFile } from "node:fs/promises";

const API_VERSION = "v25.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const IG_USER_ID_FIXO = process.env.META_IG_USER_ID || null;

if (!ACCESS_TOKEN) {
  console.error("Falta META_ACCESS_TOKEN");
  process.exit(1);
}

const BASE = `https://graph.facebook.com/${API_VERSION}`;

async function gfetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${texto.slice(0, 250)}`);
  return JSON.parse(texto);
}

const round1 = (n) => Math.round(n * 10) / 10;
const dstr = (d) => d.toISOString().slice(0, 10);
const unix = (d) => Math.floor(d.getTime() / 1000);
const pctChange = (cur, prev) =>
  prev ? round1(((cur - prev) / prev) * 100) : null;

async function descobrirContaIG() {
  if (IG_USER_ID_FIXO) return { id: IG_USER_ID_FIXO, username: null };
  const paginas = await gfetch(
    `/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50`
  );
  const comIG = (paginas.data || []).filter((p) => p.instagram_business_account);
  if (!comIG.length) {
    throw new Error(
      "Nenhuma Página com Instagram vinculado acessível a este token. " +
      "Atribua a Página da loja ao system user e gere o token com instagram_basic, " +
      "instagram_manage_insights e pages_read_engagement."
    );
  }
  if (comIG.length > 1) {
    console.log(`[aviso] ${comIG.length} contas de Instagram acessíveis. Usando a primeira. Para fixar outra, crie o secret META_IG_USER_ID com o ID correspondente:`);
    for (const p of comIG) {
      console.log(`[aviso]   @${p.instagram_business_account.username} -> ID ${p.instagram_business_account.id}`);
    }
  }
  return comIG[0].instagram_business_account;
}

// Total de uma métrica de conta num intervalo (metric_type=total_value)
async function metricaTotal(igId, metrica, desde, ate) {
  try {
    const r = await gfetch(
      `/${igId}/insights?metric=${metrica}&period=day&metric_type=total_value` +
      `&since=${unix(desde)}&until=${unix(ate)}`
    );
    return r.data?.[0]?.total_value?.value ?? null;
  } catch (e) {
    console.log(`[aviso] métrica ${metrica} indisponível: ${e.message.slice(0, 110)}`);
    return null;
  }
}

async function demografia(igId, breakdown) {
  const r = await gfetch(
    `/${igId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${breakdown}`
  );
  return (r.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).map((x) => ({
    valor: (x.dimension_values || []).join(" "),
    qtd: x.value || 0,
  }));
}

async function main() {
  const data = JSON.parse(await readFile("data.json", "utf-8"));
  const out = { disponivel: false };

  const agora = new Date();
  const d30 = new Date(agora); d30.setDate(d30.getDate() - 30);
  const d60 = new Date(agora); d60.setDate(d60.getDate() - 60);

  try {
    const conta = await descobrirContaIG();
    console.log(`[info] Conta do Instagram: ${conta.username ? "@" + conta.username : conta.id}`);

    // ---- Perfil ----
    const perfil = await gfetch(
      `/${conta.id}?fields=username,name,followers_count,media_count`
    );
    out.disponivel = true;
    out.username = perfil.username;
    out.seguidores = perfil.followers_count;
    out.totalPosts = perfil.media_count;

    // ---- KPIs dos últimos 30 dias vs 30 anteriores ----
    for (const [chave, metrica] of [
      ["visualizacoes", "views"],
      ["alcance", "reach"],
      ["interacoes", "total_interactions"],
      ["cliquesLink", "profile_links_taps"],
    ]) {
      const atual = await metricaTotal(conta.id, metrica, d30, agora);
      if (atual === null) continue;
      const anterior = await metricaTotal(conta.id, metrica, d60, d30);
      out[chave] = { valor: atual, variacaoPct: pctChange(atual, anterior) };
    }

    // ---- Novos seguidores (série diária dos últimos 30 dias) ----
    try {
      const r = await gfetch(
        `/${conta.id}/insights?metric=follower_count&period=day&since=${unix(d30)}&until=${unix(agora)}`
      );
      const serie = r.data?.[0]?.values || [];
      out.novosSeguidores30d = serie.reduce((s, v) => s + (v.value || 0), 0);
    } catch (e) {
      console.log(`[aviso] novos seguidores indisponível: ${e.message.slice(0, 110)}`);
    }

    // ---- Histórico de seguidores (snapshot diário acumulado pelo dashboard) ----
    const hoje = dstr(agora);
    const hist = (data.instagram?.historicoSeguidores || []).filter((h) => h.d !== hoje);
    hist.push({ d: hoje, s: perfil.followers_count });
    out.historicoSeguidores = hist.slice(-400);

    // ---- Origem estimada das visualizações (orgânico x anúncios) ----
    // A API do IG não separa; estimamos com as impressões de anúncio já
    // coletadas pelo fetch-meta-ads.mjs. É uma APROXIMAÇÃO (métricas de
    // plataformas diferentes) — o dashboard rotula como estimativa.
    if (out.visualizacoes?.valor && Array.isArray(data.marketing?.dailyAds)) {
      const corte = dstr(d30);
      const impressoesAds = data.marketing.dailyAds
        .filter((x) => x.date >= corte)
        .reduce((s, x) => s + (x.impressions || 0), 0);
      if (impressoesAds > 0 && impressoesAds < out.visualizacoes.valor) {
        out.origemEstimada = {
          anuncios: impressoesAds,
          organico: out.visualizacoes.valor - impressoesAds,
          anunciosPct: round1((impressoesAds / out.visualizacoes.valor) * 100),
        };
      }
    }

    // ---- Demografia ----
    try {
      const genero = await demografia(conta.id, "gender");
      const total = genero.reduce((s, g) => s + g.qtd, 0);
      if (total > 0) {
        const f = genero.find((g) => g.valor === "F")?.qtd || 0;
        const m = genero.find((g) => g.valor === "M")?.qtd || 0;
        out.generoPct = { mulheres: round1((f / total) * 100), homens: round1((m / total) * 100) };
      }
    } catch (e) { console.log(`[aviso] gênero indisponível: ${e.message.slice(0, 110)}`); }
    try {
      const idades = await demografia(conta.id, "age");
      idades.sort((a, b) => b.qtd - a.qtd);
      out.faixasEtarias = idades.slice(0, 4);
    } catch (e) { console.log(`[aviso] idade indisponível: ${e.message.slice(0, 110)}`); }
    try {
      const cidades = await demografia(conta.id, "city");
      cidades.sort((a, b) => b.qtd - a.qtd);
      const totalSeg = out.seguidores || 1;
      out.cidades = cidades.slice(0, 5).map((c) => ({
        cidade: c.valor,
        pct: round1((c.qtd / totalSeg) * 100),
      }));
    } catch (e) { console.log(`[aviso] cidades indisponíveis: ${e.message.slice(0, 110)}`); }

    // ---- Posts: top 5 e desempenho por formato (últimos 30 dias) ----
    try {
      const midia = await gfetch(
        `/${conta.id}/media?fields=id,caption,media_type,media_product_type,permalink,` +
        `thumbnail_url,media_url,timestamp,like_count,comments_count&limit=50`
      );
      const posts = [];
      for (const p of midia.data || []) {
        let views = null, reach = null, inter = null;
        try {
          const ins = await gfetch(`/${p.id}/insights?metric=views,reach,total_interactions`);
          for (const m of ins.data || []) {
            const v = m.values?.[0]?.value ?? null;
            if (m.name === "views") views = v;
            if (m.name === "reach") reach = v;
            if (m.name === "total_interactions") inter = v;
          }
        } catch {
          try {
            const ins = await gfetch(`/${p.id}/insights?metric=views`);
            views = ins.data?.[0]?.values?.[0]?.value ?? null;
          } catch { /* segue com curtidas */ }
        }
        posts.push({
          tipo: p.media_product_type === "REELS" ? "Reel" :
                p.media_type === "CAROUSEL_ALBUM" ? "Carrossel" :
                p.media_type === "VIDEO" ? "Vídeo" : "Post",
          legenda: (p.caption || "").slice(0, 90),
          link: p.permalink,
          thumb: p.thumbnail_url || p.media_url || null,
          data: (p.timestamp || "").slice(0, 10),
          views, reach,
          interacoes: inter ?? ((p.like_count || 0) + (p.comments_count || 0)),
          curtidas: p.like_count ?? null,
        });
      }

      // Desempenho por formato: só posts publicados nos últimos 30 dias
      const corte = dstr(d30);
      const doMes = posts.filter((p) => p.data >= corte);
      const porFormato = {};
      for (const p of doMes) {
        if (!porFormato[p.tipo]) porFormato[p.tipo] = { posts: 0, views: 0, alcance: 0, interacoes: 0 };
        const f = porFormato[p.tipo];
        f.posts += 1;
        f.views += p.views || 0;
        f.alcance += p.reach || 0;
        f.interacoes += p.interacoes || 0;
      }
      out.porFormato = Object.entries(porFormato)
        .map(([formato, v]) => ({ formato, ...v }))
        .sort((a, b) => b.views - a.views);
      out.postsNoMes = doMes.length;

      posts.sort((a, b) => (b.views ?? b.curtidas ?? 0) - (a.views ?? a.curtidas ?? 0));
      out.topPosts = posts.slice(0, 5).map(({ reach, curtidas, ...resto }) => resto);
      console.log(`[info] ${posts.length} posts analisados (${doMes.length} no mês), top 5 exportados.`);
    } catch (e) {
      console.log(`[aviso] posts indisponíveis: ${e.message.slice(0, 110)}`);
    }

    out.atualizadoEm = agora.toISOString();
  } catch (err) {
    console.log(`[aviso] Instagram indisponível: ${err.message.slice(0, 300)}`);
    out.motivo = err.message.slice(0, 250);
    if (data.instagram?.disponivel) {
      console.log("[aviso] Mantendo os dados anteriores do Instagram.");
      data.instagram.avisoDesatualizado = true;
      await writeFile("data.json", JSON.stringify(data, null, 2));
      return;
    }
  }

  data.instagram = out;
  await writeFile("data.json", JSON.stringify(data, null, 2));
  console.log("data.json atualizado com dados do Instagram.");
}

main().catch((err) => {
  console.error(`[aviso] Erro inesperado no Instagram: ${err.message}`);
  process.exit(0);
});
