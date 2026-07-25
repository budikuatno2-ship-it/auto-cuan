-- Mandatory read-only report before enabling destructive expiry enforcement.
SELECT g.telegram_user_id,g.user_id,g.expires_at,
 CASE WHEN x.telegram_user_id IS NOT NULL THEN 'EXEMPT_CONFIGURED_' || upper(x.reason) WHEN a.telegram_user_id IS NOT NULL THEN 'EXEMPT_ADMIN' WHEN e.lifetime THEN 'EXEMPT_LIFETIME' WHEN g.expires_at < now() THEN 'WOULD_REMOVE' ELSE 'KEEP' END action
FROM public.membership_channel_grants g
LEFT JOIN public.membership_admin_telegram_links a ON a.telegram_user_id=g.telegram_user_id AND a.revoked_at IS NULL
LEFT JOIN public.membership_entitlements e ON e.id=g.entitlement_id
LEFT JOIN public.membership_channel_exemptions x ON x.telegram_user_id=g.telegram_user_id
ORDER BY action,g.expires_at;
