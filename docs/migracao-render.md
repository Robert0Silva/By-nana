# Mudança para o Render: site, banco e fotos num só lugar

Hoje o site roda no plano gratuito do Render, o banco fica no Neon e as fotos enviadas pelo painel ficam no disco temporário do servidor, que é apagado a cada deploy. Depois desta mudança, tudo fica no Render: o site num plano pago, as fotos num disco persistente (`/var/data`) e o banco num Render Postgres (`by-nana-db`). O `render.yaml` já descreve esse estado final.

O site fica fora do ar por uns 15 minutos (passos 6 a 11). Faça num horário sem movimento e tenha o roteiro inteiro em mãos antes de começar.

## O que mexe com dado real

Os passos 2, 7, 8 e 9 leem o banco de produção do Neon, e o passo 8 grava no banco novo do Render. O Neon nunca é alterado: ele fica intacto como reserva. Nenhum script imprime as URLs dos bancos; mesmo assim, não cole essas URLs em chat, e-mail ou commit.

## Antes do dia

1. **Ferramentas do PostgreSQL 17 no computador.** Instale pelo instalador oficial (postgresql.org/download/windows), marcando só "Command Line Tools". Confira com `pg_dump --version`: precisa ser 17 ou maior, e não menor que a versão do Neon (no Neon, SQL Editor → `SHOW server_version;`). Se o Neon estiver numa versão acima de 17, mude `postgresMajorVersion` no `render.yaml` para a mesma versão e instale as ferramentas dessa versão.
2. **Ensaio do resgate das fotos (só leitura).** No PowerShell, na pasta do projeto, com a URL do Neon (painel do Neon → Connect) e o endereço do site:

       $env:DATABASE_URL = "<URL do Neon>"; $env:SITE_URL = "https://<endereço do site>"; node db/rescue-uploads.js

   O relatório lista o que existe só no site (precisa ser salvo) e o que já se perdeu (reenviar pelo painel depois). Nada é gravado sem `--write`.
3. **Preços.** Confira no painel do Render o valor do plano `0.5c-512mb`, do disco de 1 GB e do Postgres `0.1c-256mb`.

## No dia

4. **Resgatar as fotos (site ainda no ar).** Mesmo comando do passo 2, agora com `--write`. Os arquivos vão para `assets/` no projeto. Confira com `git status`, faça o commit e **ainda não faça push**.
5. **Criar o banco no Render.** New → Postgres: nome `by-nana-db`, região Oregon, versão 17, plano `0.1c-256mb`, banco `bynana`, usuário `bynana`. Crie à mão: o `render.yaml` com esse banco só chega ao Render no passo 11, e com o mesmo nome ele passa a gerenciar este banco em vez de criar outro. Copie a **External Database URL** (para os passos 8 e 9) e a **Internal Database URL** (para o passo 10).
6. **Tirar o site do ar.** No serviço `by-nana`: Settings → Suspend Web Service. Daqui em diante ninguém compra, e o Neon fica parado no estado que será copiado.
7. **Exportar o Neon.** Use a URL **sem pooler** (no Neon, Connect → desligue "Connection pooling"; o endereço não pode ter `-pooler`):

       pg_dump "<URL do Neon sem pooler>" --format=custom --no-owner --no-acl --file=bynana-migracao.dump

8. **Importar no Render** (o banco precisa estar vazio, recém-criado):

       pg_restore --no-owner --no-acl --exit-on-error --dbname="<External Database URL do Render>" bynana-migracao.dump

9. **Conferir a cópia, antes de qualquer outra coisa tocar o banco novo:**

       $env:SOURCE_DATABASE_URL = "<URL do Neon>"; $env:TARGET_DATABASE_URL = "<External Database URL do Render>"; node db/compare-databases.js

   Todas as tabelas precisam sair `ok` e a última linha precisa ser "Todas as tabelas iguais.". Se aparecer qualquer diferença, **pare aqui**: reative o serviço (Resume), e o site volta exatamente como estava, no Neon.
10. **Apontar o site para o Render.** No serviço `by-nana`, em Environment: `DATABASE_URL` = Internal Database URL do Render e `UPLOAD_DIR` = `/var/data/uploads`. Se o serviço não for gerenciado por Blueprint, ajuste também à mão: Instance Type `0.5c-512mb`, Disks → disco `uploads` em `/var/data` com 1 GB, e Build Command `npm ci`.
11. **Publicar.** Faça o push (fotos resgatadas, `render.yaml` e scripts) e reative o serviço. O deploy roda o `migrate.js`, que só completa o esquema e não recadastra o catálogo de exemplo, porque o banco já tem produtos.

## Conferência depois de voltar ao ar

12. `https://<site>/api/health` responde `{"ok":true,...}`; a página inicial, uma categoria e um produto abrem com foto; o login do painel funciona e os pedidos antigos aparecem.
13. Fotos no site novo, sem nada a mais perdido além do que o passo 4 já apontava:

        $env:DATABASE_URL = "<External Database URL do Render>"; $env:SITE_URL = "https://<site>"; node db/rescue-uploads.js

14. **Prova do disco:** envie uma foto de teste pelo painel (por exemplo, numa peça inativa), faça um Manual Deploy e confira que a foto continua lá. Depois apague a foto de teste.
15. Reenvie pelo painel as fotos que o passo 4 apontou como já perdidas.

## Depois

Deixe o Neon intacto, sem apagar, por pelo menos 4 semanas. **Voltar atrás** (trocar o `DATABASE_URL` de volta para o Neon) só é seguro antes de o site novo receber pedidos ou cadastros: depois disso, o que entrou no Render não existe no Neon.

Troque o `DATABASE_URL` do `.env` local para um banco de desenvolvimento, nunca o do Render. Apague o arquivo `bynana-migracao.dump` do computador quando a mudança estiver conferida, porque ele contém dados de clientes.

O backup passa a ser do Render: confira em `by-nana-db` → Recovery a restauração para um ponto no tempo, e em `by-nana` → Disks os snapshots do disco de fotos. A cópia semanal própria com `pg_dump`, descrita no README, continua valendo, agora com a URL do Render.
