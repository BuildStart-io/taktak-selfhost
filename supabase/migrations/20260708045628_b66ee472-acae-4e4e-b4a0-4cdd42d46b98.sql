ALTER TABLE public.revenue DROP CONSTRAINT IF EXISTS revenue_type_check;
ALTER TABLE public.revenue ADD CONSTRAINT revenue_type_check CHECK (type = ANY (ARRAY['subscription','sponsored','boost','premium_alert','listing_fee']));

UPDATE payments SET status='paid', gateway_response='{"source":"manual_reconcile"}'::jsonb WHERE reference='TAK77162362293' AND status='pending';
UPDATE listings SET status='active', payment_status='paid', paid_at=now() WHERE id=(SELECT listing_id FROM payments WHERE reference='TAK77162362293');
INSERT INTO revenue (user_id, type, amount, description) SELECT seller_id, 'listing_fee', amount, 'Listing fee (OnePay ref TAK77162362293)' FROM payments WHERE reference='TAK77162362293';