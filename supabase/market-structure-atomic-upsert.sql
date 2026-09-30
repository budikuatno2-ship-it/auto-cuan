-- Atomic, fail-closed upsert for verified Free Float/HSC snapshots.
-- SECURITY INVOKER is intentional. Execution is restricted to service_role.

CREATE OR REPLACE FUNCTION public.upsert_verified_market_structure_rows(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  item jsonb;
  affected integer;
  total_count integer := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF NULLIF(trim(item->>'ticker'), '') IS NULL THEN
      RAISE EXCEPTION 'market-structure row missing ticker';
    END IF;

    INSERT INTO public.stock_fundamentals (
      ticker,
      free_float_pct,
      free_float_source,
      free_float_as_of,
      hsc_flag,
      hsc_source,
      hsc_as_of,
      updated_at
    )
    VALUES (
      upper(trim(item->>'ticker')),
      CASE WHEN item ? 'free_float_pct' AND item->'free_float_pct' <> 'null'::jsonb
        THEN (item->>'free_float_pct')::numeric ELSE NULL END,
      NULLIF(item->>'free_float_source', ''),
      CASE WHEN NULLIF(item->>'free_float_as_of', '') IS NOT NULL
        THEN (item->>'free_float_as_of')::date ELSE NULL END,
      CASE WHEN item ? 'hsc_flag' AND item->'hsc_flag' <> 'null'::jsonb
        THEN (item->>'hsc_flag')::boolean ELSE NULL END,
      NULLIF(item->>'hsc_source', ''),
      CASE WHEN NULLIF(item->>'hsc_as_of', '') IS NOT NULL
        THEN (item->>'hsc_as_of')::date ELSE NULL END,
      COALESCE(
        CASE WHEN NULLIF(item->>'updated_at', '') IS NOT NULL
          THEN (item->>'updated_at')::timestamptz ELSE NULL END,
        now()
      )
    )
    ON CONFLICT (ticker) DO UPDATE
    SET
      free_float_pct = CASE
        WHEN EXCLUDED.free_float_pct IS NOT NULL THEN EXCLUDED.free_float_pct
        ELSE stock_fundamentals.free_float_pct
      END,
      free_float_source = CASE
        WHEN EXCLUDED.free_float_pct IS NOT NULL THEN EXCLUDED.free_float_source
        ELSE stock_fundamentals.free_float_source
      END,
      free_float_as_of = CASE
        WHEN EXCLUDED.free_float_pct IS NOT NULL THEN EXCLUDED.free_float_as_of
        ELSE stock_fundamentals.free_float_as_of
      END,
      hsc_flag = CASE
        WHEN EXCLUDED.hsc_flag IS NOT NULL THEN EXCLUDED.hsc_flag
        ELSE stock_fundamentals.hsc_flag
      END,
      hsc_source = CASE
        WHEN EXCLUDED.hsc_flag IS NOT NULL THEN EXCLUDED.hsc_source
        ELSE stock_fundamentals.hsc_source
      END,
      hsc_as_of = CASE
        WHEN EXCLUDED.hsc_flag IS NOT NULL THEN EXCLUDED.hsc_as_of
        ELSE stock_fundamentals.hsc_as_of
      END,
      updated_at = GREATEST(
        COALESCE(stock_fundamentals.updated_at, '-infinity'::timestamptz),
        COALESCE(EXCLUDED.updated_at, now())
      )
    WHERE
      (
        EXCLUDED.free_float_pct IS NULL
        OR stock_fundamentals.free_float_pct IS NULL
        OR stock_fundamentals.free_float_as_of IS NULL
        OR EXCLUDED.free_float_as_of > stock_fundamentals.free_float_as_of
        OR (
          EXCLUDED.free_float_as_of = stock_fundamentals.free_float_as_of
          AND EXCLUDED.free_float_pct IS NOT DISTINCT FROM stock_fundamentals.free_float_pct
        )
      )
      AND
      (
        EXCLUDED.hsc_flag IS NULL
        OR stock_fundamentals.hsc_flag IS NULL
        OR stock_fundamentals.hsc_as_of IS NULL
        OR EXCLUDED.hsc_as_of > stock_fundamentals.hsc_as_of
        OR (
          EXCLUDED.hsc_as_of = stock_fundamentals.hsc_as_of
          AND EXCLUDED.hsc_flag IS NOT DISTINCT FROM stock_fundamentals.hsc_flag
        )
      );

    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'stale or conflicting market-structure snapshot rejected for ticker %',
        upper(trim(item->>'ticker'));
    END IF;

    total_count := total_count + 1;
  END LOOP;

  RETURN total_count;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_verified_market_structure_rows(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_verified_market_structure_rows(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_verified_market_structure_rows(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_verified_market_structure_rows(jsonb) TO service_role;
