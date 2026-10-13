-- Step 11 follow-up: a buyer's WhatsApp and call consent belongs to a phone
-- number. A new number at the same buyer needs its own opt-in; email
-- consent stays with the buyer. Null: not tied to an address.
ALTER TABLE `messaging_consents` ADD `address` text;
