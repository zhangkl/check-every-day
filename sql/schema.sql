-- =============================================================================
-- PDCA 好习惯 · 云数据库结构（发布前落盘）
--
-- 来源：2026-11-11 从线上应用 wbapp_RcXQRfofGfmhSXvTK7lyCN 的
--       information_schema / pg_policies / pg_get_functiondef 只读导出后整理。
-- 用途：换环境、重建库、或线上结构被误改时可按本文件恢复；也可用于 Review 权限边界。
--
-- 执行方式：用云服务的 migrate（管理员）角色，按文件顺序逐条执行；
--           本文件全部幂等（IF NOT EXISTS / DROP POLICY IF EXISTS / OR REPLACE），
--           已在库上重复执行不会破坏现有数据。
-- 依赖：平台的 auth.uid()（JWT 里的用户 id）、角色 anon / authenticated / service_role。
--
-- 权限模型要点（改动前务必看懂）：
--   1) ced_members 只允许读「自己那一行」，写入只能通过 SECURITY DEFINER 的
--      ced_join_family RPC，避免客户端自己把 member_role 改成 parent。
--   2) ced_families 允许家庭成员读写整份 doc（乐观锁靠 rev 列，见 utils/store.js:467）。
--      注意：这意味着「家长专属操作」在数据库层并没有隔离，本轮加的 requireParent()
--      是应用层防误触，不是安全边界。孩子能读到 doc 里的 parentPin 明文。
--   3) GRANT 与 RLS 是两道独立的门：漏 GRANT 会报 42501，看起来像策略没生效。
--      anon 只给 SELECT（线上现状），JWT 过期降级 anon 后写操作必然 permission denied，
--      客户端靠 reloginSilent() 恢复登录态。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ced_families (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id            text        NOT NULL DEFAULT auth.uid(),
  invite_code         text        NOT NULL UNIQUE,
  doc                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rev                 integer     NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  parent_invite_code  text
);

CREATE TABLE IF NOT EXISTS public.ced_members (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id     bigint      NOT NULL,
  owner_id      text        NOT NULL DEFAULT auth.uid(),
  member_role   text        NOT NULL DEFAULT 'child',
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ced_members_family_id_owner_id_key UNIQUE (family_id, owner_id)
);

-- 按成员查家庭时的索引（线上有，别漏；数据量小但 RLS 子查询会用到）
CREATE INDEX IF NOT EXISTS ced_members_owner_idx ON public.ced_members (owner_id);

-- -----------------------------------------------------------------------------
-- 2. 授权 + RLS（顺序不能反：先 GRANT，再建策略）
-- -----------------------------------------------------------------------------
GRANT SELECT                                   ON public.ced_families TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE           ON public.ced_families TO authenticated, service_role;
GRANT SELECT                                   ON public.ced_members  TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE           ON public.ced_members  TO authenticated, service_role;
-- identity 列需要序列权限；若平台用默认序列命名，显式补上更稳
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

ALTER TABLE public.ced_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ced_members  ENABLE ROW LEVEL SECURITY;

-- 家长/孩子都能读自己所在家庭的文档；members 的子查询是 RLS 内嵌查询
DROP POLICY IF EXISTS ced_families_read_member ON public.ced_families;
CREATE POLICY ced_families_read_member ON public.ced_families
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR id IN (SELECT m.family_id FROM public.ced_members m WHERE m.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS ced_families_insert_own ON public.ced_families;
CREATE POLICY ced_families_insert_own ON public.ced_families
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS ced_families_update_member ON public.ced_families;
CREATE POLICY ced_families_update_member ON public.ced_families
  FOR UPDATE TO authenticated
  USING (
    owner_id = auth.uid()
    OR id IN (SELECT m.family_id FROM public.ced_members m WHERE m.owner_id = auth.uid())
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR id IN (SELECT m.family_id FROM public.ced_members m WHERE m.owner_id = auth.uid())
  );

DROP POLICY IF EXISTS ced_families_delete_own ON public.ced_families;
CREATE POLICY ced_families_delete_own ON public.ced_families
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS ced_members_read_own ON public.ced_members;
CREATE POLICY ced_members_read_own ON public.ced_members
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- 只允许「以自己身份」插入成员行；没有 UPDATE / DELETE 策略，角色不可自行提权
DROP POLICY IF EXISTS ced_members_write_own ON public.ced_members;
CREATE POLICY ced_members_write_own ON public.ced_members
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 3. 加入家庭 RPC（SECURITY DEFINER，绕过 members 的 RLS 完成插入）
--    按线上 pg_get_functiondef() 原样还原。
--    p_code 可以是普通邀请码或家长邀请码：用家长码直接成为 parent，跳过 PIN 校验。
--    注意：SECURITY DEFINER 函数的 owner 必须是能绕过 RLS 的迁移角色；
--    若手工重建函数时用了普通角色，加入家庭会静默失败。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ced_join_family(
  p_code text,
  p_role text DEFAULT 'child'::text,
  p_pin  text DEFAULT ''::text
)
RETURNS TABLE(out_family_id bigint, out_family_name text, out_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_f ced_families%ROWTYPE;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_f FROM ced_families f
   WHERE upper(f.invite_code) = upper(btrim(p_code))
      OR upper(f.parent_invite_code) = upper(btrim(p_code))
   LIMIT 1;

  IF v_f.id IS NULL THEN
    RAISE EXCEPTION 'CODE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF upper(v_f.parent_invite_code) = upper(btrim(p_code)) THEN
    v_role := 'parent';
  ELSE
    v_role := lower(coalesce(nullif(btrim(p_role), ''), 'child'));
    IF v_role <> 'parent' THEN v_role := 'child'; END IF;
    IF v_role = 'parent'
       AND coalesce(v_f.doc->>'parentPin', '') <> ''
       AND coalesce(p_pin, '') <> v_f.doc->>'parentPin' THEN
      RAISE EXCEPTION 'PIN_REQUIRED' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO ced_members AS m (family_id, owner_id, member_role)
  VALUES (v_f.id, auth.uid(), v_role)
  ON CONFLICT ON CONSTRAINT ced_members_family_id_owner_id_key DO NOTHING;

  RETURN QUERY SELECT v_f.id, COALESCE(v_f.doc->'family'->>'name', '我们家'), v_role;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ced_join_family(text, text, text) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. 执行后自检（只读，逐条执行）
--    SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename LIKE 'ced_%' ORDER BY 1,2;  -- 应 6 条
--    SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'ced_%';                       -- 两张表都为 true
--    SELECT count(*) FROM ced_families;                                                              -- 现有数据没丢
-- =============================================================================
