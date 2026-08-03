// scripts/fetch-instagram.mjs
//
// Busca dados do perfil do Instagram (seguidores, demografia, top posts)
// via Instagram Graph API e mescla em data.instagram no data.json.
// Roda depois do fetch-meta-ads.mjs, usando O MESMO token (META_ACCESS_TOKEN),
// que precisa das permissões: instagram_basic, instagram_manage_insights,
// pages_read_engagement — e a Página do Facebook atribuída ao system user.
//
// Cada bloco é tolerante a falha: se a demografia não vier (ex: conta com
// menos de 100 seguidores, ou permissão faltando), o resto segue normal.

import { readFile, writeFile } from "node:fs/promises";

const API_VERSION = "v25.0";
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
// Opcional: fixa o ID da conta do Instagram. Sem ele, o script descobre
// sozinho pela primeira Página com Instagram vinculado.
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

// Descobre a conta do Instagram vinculada às Páginas que o token enxerga
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
    console.log(
      `[aviso] ${comIG.length} contas de Instagram acessíveis: ${comIG
        .map((p) => "@" + p.instagram_business_account.username)
        .join(", ")}. Usando a primeira. Para fixar outra, defina o secret META_IG_USER_ID.`
    );
  }
  return comIG[0].instagram_business_account;
}

// Demografia dos seguidores: uma chamada por dimensão (idade, gênero, cidade)
async function demografia(igId, breakdown) {
  const r = await gfetch(
    `/${igId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${breakdown}`
  );
  const resultados =
    r.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
  return resultados.map((x) => ({
    valor: (x.dimension_values || []).join(" "),
    qtd: x.value || 0,
  }));
}

async function main() {
  const data = JSON.parse(await readFile("data.json", "utf-8"));
  const out = { disponivel: false };

  try {
    const conta = await descobrirContaIG();
    console.log(`[info] Conta do Instagram: ${conta.username ? "@" + conta.username : conta.id}`);

    // ---- Perfil ----
    const perfil = await gfetch(
      `/${conta.id}?fields=username,name,followers_count,media_count,profile_picture_url`
    );
    out.disponivel = true;
    out.username = perfil.username;
    out.seguidores = perfil.followers_count;
    out.totalPosts = perfil.media_count;

    // ---- Alcance dos últimos 28 dias ----
    try {
      const r = await gfetch(`/${conta.id}/insights?metric=reach&period=days_28`);
      const serie = r.data?.[0]?.values || [];
      out.alcance28d = serie.length ? serie[serie.length - 1].value : null;
    } catch (e) {
      console.log(`[aviso] alcance indisponível: ${e.message.slice(0, 120)}`);
    }

    // ---- Demografia (exige ~100+ seguidores) ----
    try {
      const genero = await demografia(conta.id, "gender");
      const total = genero.reduce((s, g) => s + g.qtd, 0);
      if (total > 0) {
        const f = genero.find((g) => g.valor === "F")?.qtd || 0;
        const m = genero.find((g) => g.valor === "M")?.qtd || 0;
        out.generoPct = {
          mulheres: round1((f / total) * 100),
          homens: round1((m / total) * 100),
        };
      }
    } catch (e) {
      console.log(`[aviso] gênero indisponível: ${e.message.slice(0, 120)}`);
    }
    try {
      const idades = await demografia(conta.id, "age");
      idades.sort((a, b) => b.qtd - a.qtd);
      out.faixasEtarias = idades.slice(0, 4);
    } catch (e) {
      console.log(`[aviso] idade indisponível: ${e.message.slice(0, 120)}`);
    }
    try {
      const cidades = await demografia(conta.id, "city");
      cidades.sort((a, b) => b.qtd - a.qtd);
      const totalSeg = out.seguidores || cidades.reduce((s, c) => s + c.qtd, 0);
      out.cidades = cidades.slice(0, 5).map((c) => ({
        cidade: c.valor,
        pct: totalSeg ? round1((c.qtd / totalSeg) * 100) : null,
      }));
    } catch (e) {
      console.log(`[aviso] cidades indisponíveis: ${e.message.slice(0, 120)}`);
    }

    // ---- Top posts por visualizações (últimos ~40 posts) ----
    try {
      const midia = await gfetch(
        `/${conta.id}/media?fields=id,caption,media_type,media_product_type,permalink,` +
        `thumbnail_url,media_url,timestamp,like_count,comments_count&limit=40`
      );
      const posts = [];
      for (const p of midia.data || []) {
        let views = null;
        try {
          const ins = await gfetch(`/${p.id}/insights?metric=views`);
          views = ins.data?.[0]?.values?.[0]?.value ?? null;
        } catch {
          // alguns tipos/posts antigos não têm a métrica — segue com curtidas
        }
        posts.push({
          tipo: p.media_product_type === "REELS" ? "Reel" :
                p.media_type === "CAROUSEL_ALBUM" ? "Carrossel" :
                p.media_type === "VIDEO" ? "Vídeo" : "Post",
          legenda: (p.caption || "").slice(0, 90),
          link: p.permalink,
          thumb: p.thumbnail_url || p.media_url || null,
          data: (p.timestamp || "").slice(0, 10),
          views,
          curtidas: p.like_count ?? null,
          comentarios: p.comments_count ?? null,
        });
      }
      posts.sort((a, b) => (b.views ?? b.curtidas ?? 0) - (a.views ?? a.curtidas ?? 0));
      out.topPosts = posts.slice(0, 5);
      console.log(`[info] ${posts.length} posts analisados, top 5 exportados.`);
    } catch (e) {
      console.log(`[aviso] posts indisponíveis: ${e.message.slice(0, 120)}`);
    }

    out.atualizadoEm = new Date().toISOString();
  } catch (err) {
    console.log(`[aviso] Instagram indisponível: ${err.message.slice(0, 300)}`);
    out.motivo = err.message.slice(0, 250);
    // Preserva os dados anteriores se existirem — melhor mostrar de ontem
    // do que nada.
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
  process.exit(0); // nunca derruba o workflow
});
