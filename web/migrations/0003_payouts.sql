-- FlowEngine v4 pushes payouts to holders' wallets (PayoutPaid, with a receipt id). Portfolios list a holder's
-- payouts straight from the events table: index them by holder.
CREATE INDEX events_payout_holder ON events (json_extract(data, '$.holder'), seq) WHERE name = 'PayoutPaid';
