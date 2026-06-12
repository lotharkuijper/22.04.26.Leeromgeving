/*
  Task #251 — verwijder de ongebruikte status-waarde 'archived'

  Sinds Task #250 verwijdert de chat-route (/api/chat/delete, voorheen
  /api/chat/archive) een gesprek definitief in plaats van het te archiveren.
  De waarde 'archived' wordt door geen enkele flow meer geschreven en de
  achtergebleven archief-rijen zijn al opgeruimd (zie
  supabase/maintenance/20260608_chat_cleanup_task250.sql). De CHECK-constraint
  wordt hier teruggebracht tot uitsluitend 'active', zodat het schema de
  werkelijke semantiek weerspiegelt.

  Defensief: eventuele resterende 'archived'-rijen worden eerst verwijderd
  zodat de nieuwe constraint nooit faalt.
*/

DELETE FROM conversations WHERE status = 'archived';

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check CHECK (status IN ('active'));
