-- By NaNa — schema PostgreSQL (Neon)

CREATE TABLE IF NOT EXISTS categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_lower_idx ON categories (lower(name));
-- agrupamento usado pelo mega-menu da vitrine; categorias sem grupo caem numa coluna "Categorias" no front.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS group_name TEXT;
-- texto de SEO + FAQ exibidos ao final da vitrine quando essa categoria está filtrada.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_text TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS faq_json JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS collections (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_name_lower_idx ON collections (lower(name));

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  brand         TEXT NOT NULL DEFAULT 'By NaNa',
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  tag           TEXT NOT NULL DEFAULT 'Novidade',
  price         NUMERIC(10, 2),
  img           TEXT NOT NULL,
  description   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection_id);

-- curadoria manual da seção "Novidades" da home; sem nenhum produto destacado, o site cai
-- automaticamente nos últimos cadastrados (ver getNovidades() em serve.js).
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS featured_position INTEGER;
CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured_position) WHERE is_featured = true;

-- composição do material (texto livre, ex. "Cabedal: couro\nForro: poliéster") — exibida na
-- página de produto; não é estruturado porque é conteúdo descritivo, não é filtrado/consultado.
ALTER TABLE products ADD COLUMN IF NOT EXISTS composition TEXT;

-- fotos adicionais da galeria da página de produto; a capa de sempre (products.img) continua
-- sendo a 1ª imagem da galeria (ver attachImages() em serve.js) — não duplicamos ela aqui.
CREATE TABLE IF NOT EXISTS product_images (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);

-- variação de tamanho/cor + estoque. Produto sem nenhuma linha aqui continua se comportando
-- exatamente como antes (sem seletor, sem bloqueio por estoque) — só produtos com pelo menos
-- uma variação cadastrada ganham o seletor no site.
CREATE TABLE IF NOT EXISTS product_variants (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       TEXT,
  color      TEXT,
  sku        TEXT,
  stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS variants_sku_idx ON product_variants(sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS variants_product_size_color_idx
  ON product_variants(product_id, lower(COALESCE(size, '')), lower(COALESCE(color, '')));

-- medidas daquele tamanho específico (texto livre, ex. "Busto: 82cm\nComprimento: 90cm"),
-- mostradas na página de produto quando a cliente seleciona essa variação.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS measurements TEXT;

-- Razão permanente de cada entrada/saída. O saldo atual continua em product_variants.stock;
-- esta tabela explica como ele chegou ao valor atual.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id            BIGSERIAL PRIMARY KEY,
  variant_id    TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('initial', 'adjustment', 'sale', 'cancellation')),
  quantity      INTEGER NOT NULL CHECK (quantity <> 0),
  stock_after   INTEGER NOT NULL CHECK (stock_after >= 0),
  order_id      TEXT,
  admin_user_id UUID,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_variant ON inventory_movements(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order ON inventory_movements(order_id) WHERE order_id IS NOT NULL;

-- scope decides which single target_* column is set; the others stay null.
CREATE TABLE IF NOT EXISTS promotions (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL CHECK (scope IN ('product', 'category', 'collection', 'site')),
  target_product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  target_category_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  target_collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  discount_type     TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value    NUMERIC(10, 2) NOT NULL CHECK (discount_value > 0),
  label             TEXT NOT NULL DEFAULT '',
  start_date        DATE,
  end_date          DATE,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_target_matches_scope CHECK (
    (scope = 'product'    AND target_product_id    IS NOT NULL AND target_category_id IS NULL AND target_collection_id IS NULL) OR
    (scope = 'category'   AND target_category_id   IS NOT NULL AND target_product_id  IS NULL AND target_collection_id IS NULL) OR
    (scope = 'collection' AND target_collection_id IS NOT NULL AND target_product_id  IS NULL AND target_category_id  IS NULL) OR
    (scope = 'site'       AND target_product_id IS NULL AND target_category_id IS NULL AND target_collection_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_promotions_product ON promotions(target_product_id);
CREATE INDEX IF NOT EXISTS idx_promotions_category ON promotions(target_category_id);
CREATE INDEX IF NOT EXISTS idx_promotions_collection ON promotions(target_collection_id);

CREATE TABLE IF NOT EXISTS coupons (
  code           TEXT PRIMARY KEY,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(10, 2) NOT NULL CHECK (discount_value > 0),
  start_date     DATE,
  end_date       DATE,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- usuários do painel admin (login multiusuário — substitui a senha única compartilhada).
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx ON admin_users (lower(email));
-- guardado por usuário (não no navegador) para que a marcação de "já vi" acompanhe a pessoa
-- entre aparelhos/navegadores.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notifications_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- "quem fez o quê" nas ações mais relevantes do admin; admin_user_id fica nulo se o usuário
-- for removido no futuro, mas admin_name preserva o nome de quem fez a ação na época.
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id            BIGSERIAL PRIMARY KEY,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  admin_name    TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON admin_activity_log(created_at DESC);

CREATE TABLE IF NOT EXISTS customers (
  id                  UUID PRIMARY KEY,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT NOT NULL,
  birth_date          DATE NOT NULL,
  cpf                 TEXT NOT NULL,
  gender              TEXT NOT NULL DEFAULT 'nao_informado'
                        CHECK (gender IN ('feminino', 'masculino', 'nao_informado')),
  password_hash       TEXT NOT NULL,
  marketing_opt_in    BOOLEAN NOT NULL DEFAULT false,
  privacy_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_idx ON customers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS customers_cpf_idx ON customers (cpf);

-- endereços salvos pelo cliente na área da conta, para reaproveitar no checkout sem redigitar.
CREATE TABLE IF NOT EXISTS customer_addresses (
  id          UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  cep         TEXT NOT NULL,
  rua         TEXT NOT NULL,
  numero      TEXT NOT NULL,
  complemento TEXT,
  bairro      TEXT NOT NULL,
  cidade      TEXT NOT NULL,
  estado      TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON customer_addresses(customer_id);

-- lista de desejos sincronizada entre dispositivos; chave composta evita favorito duplicado.
CREATE TABLE IF NOT EXISTS customer_favorites (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

-- pedidos fechados pelo checkout do site (persistidos antes de abrir o WhatsApp, para dar
-- ao admin uma lista/histórico real em vez de depender só da mensagem enviada).
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,
  items           JSONB NOT NULL,
  subtotal        NUMERIC(10, 2) NOT NULL,
  discount        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total           NUMERIC(10, 2) NOT NULL,
  coupon_code     TEXT,
  payment_method  TEXT NOT NULL,
  delivery_method TEXT NOT NULL,
  address         JSONB,
  status          TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'em_andamento', 'concluido', 'cancelado')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- regra de frete por estado (UF). A linha com uf = '*' é o fallback usado quando o estado do
-- endereço não tem regra específica cadastrada; sem nenhuma regra (nem '*'), o frete fica 0.
CREATE TABLE IF NOT EXISTS shipping_rules (
  id         SERIAL PRIMARY KEY,
  uf         TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  price      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  free_above NUMERIC(10, 2),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shipping_rules_uf_idx ON shipping_rules (upper(uf));

-- avaliação de cliente (estrelas + comentário) para um produto. Só quem tem um pedido não
-- cancelado contendo esse produto pode avaliar (checado na rota, não aqui); uma avaliação por
-- cliente por produto — quem quiser mudar a nota edita a mesma linha em vez de duplicar.
CREATE TABLE IF NOT EXISTS product_reviews (
  id          UUID PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id    TEXT REFERENCES orders(id) ON DELETE SET NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_product_customer_idx ON product_reviews(product_id, customer_id);

-- valor de frete combinado no checkout (0 quando é retirada em loja); somado ao subtotal-desconto
-- para compor `total`, que continua sendo o valor final enviado no pedido.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping NUMERIC(10, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS stories (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  video       TEXT NOT NULL,
  cover       TEXT,
  link_url    TEXT,
  link_label  TEXT NOT NULL DEFAULT 'Ver mais',
  position    INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stories_position ON stories(position);
-- vincula o story a um produto real do catálogo; o botão do story vira "Ver produto" quando preenchido.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stories_product ON stories(product_id);

-- e-mail informado no checkout (opcional), usado para mandar confirmação e atualização de status
-- do pedido; não existia antes porque o checkout só terminava no WhatsApp.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email TEXT;

-- token de recuperação de senha ("esqueci minha senha"); nulo fora de uma solicitação em
-- andamento e limpo assim que a senha é redefinida ou o token expira.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
