-- =============================================================================
-- PDCA 好习惯 · 线上只读诊断（配套 tests/check-doc-size.js）
--
-- 用法：用云服务的 read 角色，一次执行一条（服务不支持多语句）。
-- 这些查询只返回聚合数字，不返回孩子姓名、留言、语音文字等业务内容。
-- 采集日期 2026-11-11 的基线已固化在 tests/check-doc-size.js 的 BASELINE 里。
-- 若要把真实文档导入体积脚本做精确分析，请从云控制台导出 doc JSON 后：
--   node tests/check-doc-size.js --doc ~/Downloads/ced-doc.json
-- =============================================================================

-- ① 文档总体量：JSON 文本字节数（这才是 flush 上传的 body 口径）
--    pg_column_size(doc) 是 PG 内部压缩后的存储大小，会明显小于网络传输体积，别混用。
SELECT id,
       rev,
       octet_length(doc::text)                     AS json_bytes,
       pg_column_size(doc)                        AS storage_bytes,
       updated_at
  FROM ced_families
 ORDER BY id;

-- ② 分项体积与条数：sheets / logs / activities / notices / 其它
SELECT id,
       octet_length((doc->'sheets')::text)        AS sheets_bytes,
       octet_length((doc->'logs')::text)          AS logs_bytes,
       octet_length((doc->'activities')::text)    AS activities_bytes,
       octet_length((doc->'notices')::text)       AS notices_bytes,
       (SELECT count(*) FROM jsonb_object_keys(doc->'sheets'))               AS sheet_days,
       jsonb_array_length(coalesce(doc->'logs','[]'::jsonb))                AS logs_n,
       jsonb_array_length(coalesce(doc->'activities','[]'::jsonb))          AS activities_n,
       jsonb_array_length(coalesce(doc->'notices','[]'::jsonb))             AS notices_n
  FROM ced_families
 ORDER BY id;

-- ③ 语音转文字占用：条数 / 总字数 / 最大单条 / 总字节
--    这是 doc 膨胀的主要变量；setVoiceText 目前单条上限 8000 字。
SELECT count(*)                                                   AS voices,
       count(*) FILTER (WHERE length(coalesce(v->>'text','')) > 0) AS with_text,
       sum(length(coalesce(v->>'text','')))                         AS text_chars,
       max(length(coalesce(v->>'text','')))                         AS max_text_chars,
       sum(octet_length(coalesce(v->>'text','')))                   AS text_bytes
  FROM ced_families f
 CROSS JOIN LATERAL jsonb_each(f.doc->'sheets') AS s(day, val)
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.val->'items','[]'::jsonb)) AS it
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(it->'voices','[]'::jsonb)) AS v;

-- ④ 每天清单体积：看是否线性增长、哪天突然变大
SELECT s.day,
       octet_length(s.val::text)                                              AS day_bytes,
       jsonb_array_length(coalesce(s.val->'items','[]'::jsonb))              AS items,
       (SELECT sum(jsonb_array_length(coalesce(it->'voices','[]'::jsonb)))
          FROM jsonb_array_elements(coalesce(s.val->'items','[]'::jsonb)) AS it) AS voices
  FROM ced_families f
 CROSS JOIN LATERAL jsonb_each(f.doc->'sheets') AS s(day, val)
 ORDER BY s.day;

-- ⑤ 家庭成员与角色：排查「多了个孩子」「角色不对」时先看这里
SELECT family_id, member_role, count(*) AS n
  FROM ced_members
 GROUP BY family_id, member_role
 ORDER BY family_id, member_role;

-- ⑥ 权限边界自检：应看到 6 条策略、两张表 RLS 开启
SELECT tablename, policyname, cmd, roles
  FROM pg_policies
 WHERE tablename LIKE 'ced_%'
 ORDER BY tablename, policyname;

SELECT relname, relrowsecurity AS rls_on
  FROM pg_class
 WHERE relname IN ('ced_families','ced_members');

-- -----------------------------------------------------------------------------
-- 常见故障速查
--   permission denied for table ced_families
--     → 请求 JWT 过期后降成 anon，anon 只有 SELECT。客户端有 reloginSilent()；
--       仍不行就让用户退出重登，并检查 GRANT（schema.sql 第 2 节）。
--   「数据已被另一台设备更新」频繁出现
--     → 多设备同时写，rev 乐观锁冲突；mutate() 会自动重拉重放一次，超过 4 次才报错。
--   doc 体积超过 512 KB
--     → 跑 node tests/check-doc-size.js --doc <导出文件>，按报告定留存策略。
-- =============================================================================
