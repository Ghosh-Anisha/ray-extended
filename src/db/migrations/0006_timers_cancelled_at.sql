-- Lets RAY call off a pending timer, e.g. when the merchant takes a case over.
ALTER TABLE `timers` ADD `cancelled_at` integer;