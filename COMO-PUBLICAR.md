# Como colocar o Ágora no ar

Este app tem: login/cadastro de usuários, canais de texto com chat em tempo real, e canais de voz reais pelo navegador. Ele usa dois serviços gratuitos por baixo dos panos: **Supabase** (contas + banco de dados + chat em tempo real) e **Jitsi Meet** (voz, sem precisar de conta).

## 1. Criar o backend (Supabase) — 5 minutos

1. Acesse **supabase.com**, crie uma conta gratuita e clique em **New project**.
2. Espere o projeto terminar de criar (leva ~2 min).
3. No menu lateral, abra **SQL Editor** → **New query**, cole todo o conteúdo do arquivo `schema.sql` (incluído aqui) e clique em **Run**.
4. Vá em **Project Settings → API**. Copie a **Project URL** e a chave **anon public**.
5. Abra o arquivo `config.js` e cole essas duas informações nos campos indicados.

## 2. Testar no seu computador

Como o app usa módulos, ele precisa ser aberto por um servidor local (não funciona clicando duas vezes no arquivo). Formas simples:

- Se tiver o **VS Code**, instale a extensão "Live Server" e clique em "Go Live" na pasta do projeto.
- Ou, com Python instalado, abra o terminal na pasta do projeto e rode: `python3 -m http.server`, depois acesse `http://localhost:8000` no navegador.

Crie uma conta de teste e veja se o chat funciona (abra em duas abas para simular duas pessoas conversando).

## 3. Publicar de verdade (para outras pessoas acessarem)

A forma mais simples, sem programar:

1. Acesse **netlify.com**, crie uma conta gratuita.
2. Na tela inicial, arraste a **pasta inteira do projeto** para a área de deploy ("Drag and drop your site output folder here").
3. Pronto — a Netlify te dá um link público (algo como `seusite.netlify.app`) que já funciona para qualquer pessoa, de qualquer lugar.
4. (Opcional) Em **Domain settings**, você pode conectar um domínio próprio que já tenha comprado.

## O que ainda não tem (e vale saber)

- **Confirmação de e-mail**: por padrão o Supabase pode exigir que o usuário confirme o e-mail antes de entrar. Dá pra desligar isso em Authentication → Providers → Email, se quiser um cadastro mais rápido para testes.
- **Só um "servidor"**: por enquanto todo mundo que entra no app cai no mesmo espaço com os mesmos canais. Múltiplos servidores dá pra adicionar depois (é uma tabela nova + um pouco de lógica).
- **Moderação**: não há sistema de banimento, denúncia ou apagar mensagens ainda.
- **Uso e custo**: o plano gratuito do Supabase e da Netlify aguenta um projeto pequeno/médio tranquilamente. Se crescer muito, os planos pagos entram a partir de poucos dólares por mês.

Se travar em algum desses passos, me manda a mensagem de erro que te ajudo a resolver.
