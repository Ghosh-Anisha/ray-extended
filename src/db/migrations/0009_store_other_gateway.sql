-- Step 7: the store also takes payments through another gateway. When a
-- customer's payment matches nothing at Razorpay, RAY says it's likely that
-- gateway's.
ALTER TABLE `store_settings` ADD `other_gateway` integer DEFAULT false NOT NULL;
