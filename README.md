# Dashboard Shopify

Dashboard simples que lê dados da sua loja Shopify e mostra em uma página no GitHub Pages.

## 1. Criar um app no Shopify Dev Dashboard (pegar as credenciais de acesso)

⚠️ **Importante:** desde 1º de janeiro de 2026 a Shopify não permite mais
criar o antigo "app personalizado" direto no admin. Agora é preciso usar o
**Dev Dashboard**, e em vez de um único token, você recebe duas credenciais
(**Client ID** e **Client secret**).

1. Acesse [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard/) e
   faça login com a mesma conta que você usa no admin da sua loja.
   - Alternativa: no admin da loja, vá em **Configurações → Apps e canais de
     vendas → Apps**, e clique em **Saiba mais** no card "Desenvolva e
     gerencie apps no seu Dev Dashboard" (não use a barra de busca da lista
     de apps legados — ela não leva ao lugar certo).
2. Clique em **Create app** → dê um nome (ex: "Dashboard") → **Create**.
3. Na página do app, vá em **Settings** (Configurações).
4. Em **App URL**, se não for usar o app dentro do admin, pode colocar
   `https://shopify.dev/apps/default-app-home`.
5. Em **Scopes** (permissões), marque pelo menos:
   - `read_orders`
   - `read_products`
   - `read_customers` (necessário para calcular clientes novos vs. recompra)
6. Clique em **Release** para publicar essa versão do app.
7. Ainda em **Settings**, copie o **Client ID** e o **Client secret**.
   **Guarde os dois em local seguro** — o secret só é mostrado uma vez.
8. Instale o app na sua loja (deve aparecer um botão de instalar/release
   nessa mesma tela — se não aparecer, procure por "Install app" no menu do
   app dentro do Dev Dashboard).

Você também vai precisar do domínio da loja, tipo `minhaloja.myshopify.com`
(aparece na URL do admin).

**Erro comum:** se o script der erro `shop_not_permitted`, geralmente é
porque o app foi criado numa organização diferente da loja. Verifique no
Dev Dashboard, na seção **Dev stores** (ou nas configurações da
organização), se a sua loja aparece listada junto com o app. Normalmente
isso só acontece se você tiver mais de uma organização Shopify associada à
sua conta.

> Diferente do fluxo antigo, aqui o script busca um token novo (válido por
> 24h) toda vez que roda, usando o Client ID + Client secret. Isso já está
> configurado no `scripts/fetch-shopify.mjs` — você só precisa fornecer as
> credenciais.

## 1b. Criar acesso à Meta Ads API (opcional, para dados de tráfego pago)

Esse processo é mais longo que o do Shopify porque a Meta exige um "app" e
um "usuário de sistema". Siga com calma:

1. Vá em [developers.facebook.com/apps](https://developers.facebook.com/apps)
   e clique em **Criar app**. Escolha o tipo **Negócios** (Business).
2. Dentro do app criado, adicione o produto **Marketing API** (procure na
   lista de produtos e clique em **Configurar**).
3. Vá para [business.facebook.com/settings](https://business.facebook.com/settings)
   (Business Manager da sua empresa) → **Usuários → Usuários do sistema**.
4. Clique em **Adicionar** → crie um usuário do sistema com papel **Admin**.
5. Com o usuário do sistema criado, clique em **Adicionar ativos** e dê
   acesso à **conta de anúncios** que você usa (marque como "Controle total"
   ou pelo menos leitura).
6. Clique em **Gerar novo token** para esse usuário do sistema:
   - Selecione o app que você criou no passo 1
   - Marque a permissão `ads_read`
   - Defina para **nunca expirar**, se disponível
   - Copie o token gerado (algo longo, tipo `EAAxxxxx...`)
7. Pegue o **ID da conta de anúncios**: em
   [business.facebook.com/settings/ad-accounts](https://business.facebook.com/settings/ad-accounts),
   o ID aparece como um número (ex: `1234567890`). No dashboard, use o
   formato com prefixo: `act_1234567890`.

## 2. Subir esse projeto para um repositório no GitHub

1. Crie um repositório novo no GitHub (pode ser privado).
2. Suba todos esses arquivos para ele (pelo site do GitHub, arrastando os
   arquivos, ou por linha de comando com `git`).

## 3. Configurar os Secrets

No repositório: **Settings → Secrets and variables → Actions → New repository secret**.
Crie dois secrets:

- `SHOPIFY_STORE_DOMAIN` → ex: `minhaloja.myshopify.com`
- `SHOPIFY_CLIENT_ID` → o Client ID copiado no Dev Dashboard
- `SHOPIFY_CLIENT_SECRET` → o Client secret copiado no Dev Dashboard
- `META_ACCESS_TOKEN` → o token do usuário de sistema (`EAAxxxx...`), se for usar a Meta Ads
- `META_AD_ACCOUNT_ID` → ex: `act_1234567890`, se for usar a Meta Ads

## 4. Rodar a atualização pela primeira vez

Vá na aba **Actions** do repositório → escolha o workflow
**"Atualizar dados do Shopify"** → **Run workflow**. Isso vai gerar o
`data.json` com os dados reais da sua loja.

A partir daí ele roda sozinho todo dia (o horário está configurado em
`.github/workflows/update-data.yml`, pode ajustar o `cron` se quiser outro
horário).

## 5. Ativar o GitHub Pages

**Settings → Pages** → em "Source", escolha a branch `main` e a pasta `/root`
→ Salvar. Depois de alguns minutos, o link do seu dashboard vai aparecer
nessa mesma tela (algo como `https://seuusuario.github.io/seurepositorio/`).

## Margem de lucro (opcional)

A Shopify não guarda o preço de custo em nenhum lugar acessível
automaticamente pela API padrão nesse fluxo, então a margem é calculada a
partir de um arquivo simples que **você mesmo edita**: `custos.json`, na
raiz do projeto.

Abra esse arquivo (dá pra editar direto pelo site do GitHub, sem precisar
baixar nada) e preencha assim:

```json
{
  "algodão premium": 20.00,
  "modal": 25.00,
  "pima": 38.00
}
```

- A chave é uma **palavra-chave**, não precisa ser o nome exato do produto:
  o script procura essa palavra em qualquer lugar do nome (sem diferenciar
  maiúscula/minúscula). Por exemplo, `"modal"` bate com "Blusa Modal Preta
  P", "Regata Modal Branca GG", etc — todos os produtos que tiverem "modal"
  no nome usam o mesmo custo.
- O valor é o **custo por unidade** (o que você paga por peça).
- Se um produto tiver mais de uma palavra-chave no nome, vale a primeira
  que aparecer na lista do arquivo.
- Produtos que não baterem com nenhuma palavra-chave ficam de fora do
  cálculo — o dashboard mostra "—" pra eles, e informa qual % da receita
  total já está coberta pelos custos cadastrados.

Sempre que você editar e salvar esse arquivo no GitHub, a próxima
atualização automática (ou uma rodada manual em **Actions → Run workflow**)
já recalcula a margem.

## O que o dashboard mostra hoje

- Receita, pedidos e ticket médio dos últimos 30 dias (comparado aos 30 dias
  anteriores)
- Evolução da receita nos últimos 30 dias
- Top 5 produtos por receita
- Estoque: total de peças, produtos parados (sem vender há 180+ dias),
  produtos em ruptura, cobertura de estoque (em dias) e giro no período
- Clientes novos vs. recompra no período, e % de recompra
- CAC (custo por cliente novo, calculado com o investimento em Meta Ads)
- Margem bruta do período (se você preencher o `custos.json`) — geral e por
  produto no ranking de top produtos
- Investimento em Meta Ads nos últimos 30 dias, ROAS (receita ÷ investimento)
  e lista de campanhas ativas com o gasto de cada uma (se você configurar os
  secrets `META_ACCESS_TOKEN` e `META_AD_ACCOUNT_ID`)
- Alertas automáticos com regras simples (ex: "receita caiu X%", "estoque
  parado em Y produtos", "ROAS acima de Z")

### Sobre as aproximações usadas

- **Estoque parado**: um produto é considerado parado se tem estoque
  disponível mas não aparece em nenhum pedido dos últimos 180 dias.
- **Clientes novos vs. recompra**: usa o campo `orders_count` do cliente na
  Shopify (total histórico de pedidos). Pedidos de convidados sem cadastro
  de cliente não entram nessa contagem.
- **CAC**: investimento total em Meta Ads no período ÷ número de clientes
  novos no mesmo período. É uma aproximação simples — não separa por
  campanha nem considera outros canais de aquisição.

## Próximos passos possíveis

- Adicionar mais métricas (funil, taxa de conversão, etc. — depende de
  dados que a Admin API padrão não entrega sozinha, algumas precisam do
  Shopify Analytics/relatórios)
- Incluir WhatsApp, Provador e Marketplace manualmente, editando o
  `data.json` à mão ou criando outro pedaço no script
