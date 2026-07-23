-- By NaNa — schema PostgreSQL (Neon)

CREATE TABLE IF NOT EXISTS categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_lower_idx ON categories (lower(name));
-- agrupamento usado pelo mega-menu da vitrine; categorias sem grupo caem numa coluna "Categorias" no front.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS group_name TEXT;

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
