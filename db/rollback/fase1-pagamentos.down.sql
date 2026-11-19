-- Reversão da Fase 1 (segurança financeira e PagBank). NÃO é executado automaticamente:
-- db/migrate.js só lê db/schema.sql. Rodar manualmente, apenas com autorização, e somente
-- depois de remover do db/schema.sql o bloco "Fase 1" (senão o próximo deploy recria tudo).
--
-- O script se recusa a rodar se algum pedido estiver num estado de pagamento que só existe na
-- Fase 1 — voltar o CHECK antigo nessa situação quebraria a tabela ou exigiria alterar dados
-- financeiros reais. Nesse caso, resolver os estornos primeiro.
--
-- ATENÇÃO: apaga o histórico financeiro (order_events) e as tentativas de estorno
-- (payment_refunds). Exporte essas tabelas antes, se forem necessárias.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE payment_status IN ('refund_pending', 'partially_refunded', 'refund_failed')) THEN
    RAISE EXCEPTION 'Há pedidos com estados de estorno da Fase 1 — reversão cancelada';
  END IF;
END $$;

DROP TABLE IF EXISTS payment_refunds;
DROP TABLE IF EXISTS order_events;

ALTER TABLE orders DROP COLUMN IF EXISTS payment_attention;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_check_failures;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_checked_at;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_charge_id;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_order_id;
ALTER TABLE orders DROP COLUMN IF EXISTS refunded_amount;
ALTER TABLE orders DROP COLUMN IF EXISTS paid_amount;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('manual', 'pending', 'paid', 'failed', 'refunded'));

COMMIT;
