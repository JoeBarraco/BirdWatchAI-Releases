-- Behaviour tests for setup-classroom-device-spanish.sql.
-- Order: stub-schema.sql, setup-classroom-join.sql, then
-- setup-classroom-device-spanish.sql, then this.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

do $$
declare
  t uuid := 'd1000000-0000-0000-0000-0000000000a1';
  cid uuid; room uuid; sid uuid; a json; p json; tok text := 'tok-device-es';
begin
  insert into communities (slug, name, kind, owner_user_id) values ('dev-es', 'Dev ES', 'school', t) returning id into cid;
  insert into community_members (community_id, user_id, role) values (cid, t, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id) values (cid, 'Room E', 'k-2', t) returning id into room;
  insert into classroom_sessions (classroom_id, mode, join_code) values (room, 'join_code', '424242') returning id into sid;
  insert into classroom_participants (session_id, nickname, token) values (sid, 'Ana', tok);
  perform set_config('test.uid', t::text, true);

  a := classroom_question_open(sid, '{"prompt":"Which bird came most?","prompt_es":"¿Qué pájaro vino más?",
        "choices":[{"label":"Blue Jay","es":"Chara azul"},{"label":"Northern Cardinal","es":"Cardenal norteño"}],
        "correct_index":1}');
  p := classroom_poll(tok);
  perform t_ok('A1 the phone gets the Spanish question', p->>'prompt_es' = '¿Qué pájaro vino más?');
  perform t_ok('A2 and the Spanish answers inside the choices', p->'choices'->1->>'es' = 'Cardenal norteño');
  perform t_ok('A3 and still never the right answer', p::text !~ 'correct');

  a := classroom_question_open(sid, '{"prompt":"English only","choices":[{"label":"A"},{"label":"B"}],"correct_index":0}');
  p := classroom_poll(tok);
  perform t_ok('B1 Español off: no Spanish line', p->>'prompt_es' is null and p->>'prompt' = 'English only');
end $$;
