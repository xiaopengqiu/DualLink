import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'dual-link.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',disabled INTEGER NOT NULL DEFAULT 0,daily_limit INTEGER NOT NULL DEFAULT 100,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,content TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS prompts_owner ON prompts(user_id);
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,secret_hash TEXT NOT NULL,expires_at TEXT NOT NULL,device_id TEXT,approved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,capture_key TEXT NOT NULL,device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,path TEXT NOT NULL,mime TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,capture_key));
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,provider TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,question TEXT NOT NULL DEFAULT '',prompt_name TEXT NOT NULL,prompt_snapshot TEXT NOT NULL,sources TEXT NOT NULL DEFAULT '[]',usage TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,created_at);
    CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,created_at);
    CREATE TABLE IF NOT EXISTS quota_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS quota_owner ON quota_events(user_id,created_at);
    CREATE TABLE IF NOT EXISTS ws_tickets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,kind TEXT NOT NULL,expires_at TEXT NOT NULL);
  `);
  const ticketColumns = db.prepare('PRAGMA table_info(ws_tickets)').all();
  if (!ticketColumns.some(c => c.name === 'session_hash')) db.exec('ALTER TABLE ws_tickets ADD COLUMN session_hash TEXT');
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
  for (const [column, definition] of Object.entries({ stage: "TEXT NOT NULL DEFAULT 'queued'", style_snapshot: "TEXT NOT NULL DEFAULT ''", knowledge_ids: "TEXT NOT NULL DEFAULT '[]'", needs_retrieval: 'INTEGER NOT NULL DEFAULT 0', retrieval_warning: 'TEXT' })) if (!taskColumns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  for (const column of ['request_id', 'request_fingerprint']) if (!taskColumns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_request ON tasks(user_id,request_id) WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_captures(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(task_id,capture_id),UNIQUE(task_id,position));
    CREATE INDEX IF NOT EXISTS task_captures_image ON task_captures(capture_id);
    INSERT OR IGNORE INTO task_captures(task_id,capture_id,position) SELECT id,capture_id,0 FROM tasks;
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'auto_analyze')) db.exec('ALTER TABLE users ADD COLUMN auto_analyze INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    CREATE TABLE IF NOT EXISTS interviews(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'recording',provider TEXT NOT NULL,prompt_id TEXT,prompt_name TEXT NOT NULL,style_snapshot TEXT NOT NULL,knowledge_ids TEXT NOT NULL DEFAULT '[]',hotwords TEXT NOT NULL DEFAULT '[]',auto_answer INTEGER NOT NULL DEFAULT 1,recording_status TEXT NOT NULL DEFAULT 'awaiting_device',error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ended_at TEXT);
    CREATE INDEX IF NOT EXISTS interviews_owner ON interviews(user_id,created_at);
    CREATE TABLE IF NOT EXISTS interview_segments(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,track TEXT NOT NULL,segment_key TEXT NOT NULL,text TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER,final INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,replay INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,track,segment_key));
    CREATE INDEX IF NOT EXISTS interview_segments_timeline ON interview_segments(session_id,start_ms);
    CREATE TABLE IF NOT EXISTS interview_segment_revisions(segment_id TEXT NOT NULL REFERENCES interview_segments(id) ON DELETE CASCADE,revision INTEGER NOT NULL,text TEXT NOT NULL,final INTEGER NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(segment_id,revision));
    CREATE TABLE IF NOT EXISTS interview_questions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,text TEXT NOT NULL,segment_ids TEXT NOT NULL DEFAULT '[]',revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'pending',origin TEXT NOT NULL DEFAULT 'manual',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_question_segments(question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,segment_id TEXT NOT NULL REFERENCES interview_segments(id) ON DELETE CASCADE,PRIMARY KEY(question_id,segment_id));
    CREATE TABLE IF NOT EXISTS interview_contexts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,prompt TEXT NOT NULL,sources TEXT NOT NULL,summary TEXT NOT NULL,segment_ids TEXT NOT NULL,watermark TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_answers(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,question_revision INTEGER NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',text TEXT NOT NULL DEFAULT '',error TEXT,context_snapshot_id TEXT REFERENCES interview_contexts(id) ON DELETE SET NULL,usage TEXT,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS interview_answers_queue ON interview_answers(status,created_at);
    CREATE TABLE IF NOT EXISTS interview_gaps(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,track TEXT,start_ms INTEGER,end_ms INTEGER,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unresolved',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_audio_tickets(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,mode TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_audio_frames(session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,track TEXT NOT NULL,seq INTEGER NOT NULL,start_ms INTEGER NOT NULL,sample_count INTEGER NOT NULL,byte_offset INTEGER,byte_count INTEGER NOT NULL,hash TEXT NOT NULL,replay INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(session_id,track,seq));
    CREATE INDEX IF NOT EXISTS interview_audio_timeline ON interview_audio_frames(session_id,track,start_ms);
    CREATE TABLE IF NOT EXISTS interview_audio_usage(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,samples INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,day));
    CREATE TABLE IF NOT EXISTS interview_audio_storage(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,bytes INTEGER NOT NULL DEFAULT 0);
  `);
  if (!db.prepare('PRAGMA table_info(interview_audio_frames)').all().some(c => c.name === 'asr_submitted')) db.exec('ALTER TABLE interview_audio_frames ADD COLUMN asr_submitted INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(interviews)').all().some(c => c.name === 'frame_count')) db.exec('ALTER TABLE interviews ADD COLUMN frame_count INTEGER NOT NULL DEFAULT 0');
  const migrations={interviews:{config_version:'INTEGER NOT NULL DEFAULT 0',mode:"TEXT NOT NULL DEFAULT 'transcript'",transcribe:'INTEGER NOT NULL DEFAULT 1',audio_model:"TEXT NOT NULL DEFAULT 'qwen3.8-omni-flash-realtime'",audio_window_seconds:'INTEGER NOT NULL DEFAULT 120'},interview_questions:{capture_end_ms:'INTEGER',audio_start_ms:'INTEGER',audio_end_ms:'INTEGER',audio_truncated:'INTEGER NOT NULL DEFAULT 0',trigger_watermark:'INTEGER'},interview_answers:{mode:"TEXT NOT NULL DEFAULT 'transcript'",audio_model:'TEXT'}};
  for(const [table,columns]of Object.entries(migrations)){const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const [name,type]of Object.entries(columns))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
  db.exec(`CREATE TABLE IF NOT EXISTS interview_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interview_triggers(session_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,request_id TEXT NOT NULL,question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,answer_id TEXT NOT NULL REFERENCES interview_answers(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id));`);
  if (!db.prepare('PRAGMA table_info(interview_audio_frames)').all().some(c=>c.name==='active'))db.exec('ALTER TABLE interview_audio_frames ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if(!db.prepare('PRAGMA table_info(interview_triggers)').all().some(c=>c.name==='config_version'))db.exec('ALTER TABLE interview_triggers ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0');
  const modelMigrations = {tasks:{model:'TEXT'}, interviews:{model_overrides:"TEXT NOT NULL DEFAULT '{}'",text_models:"TEXT NOT NULL DEFAULT '{}'",asr_model:"TEXT NOT NULL DEFAULT ''"},interview_answers:{model:'TEXT'}};
  for(const [table,columns] of Object.entries(modelMigrations)){const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const [name,type] of Object.entries(columns))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
  db.exec('CREATE TABLE IF NOT EXISTS model_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,value TEXT NOT NULL)');
  if (!db.prepare('PRAGMA table_info(captures)').all().some(c=>c.name==='size')) db.exec('ALTER TABLE captures ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE INDEX IF NOT EXISTS captures_history ON captures(user_id,created_at,id);
    CREATE TABLE IF NOT EXISTS history_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history_capture_deletions(user_id TEXT NOT NULL,capture_key TEXT NOT NULL,capture_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(user_id,capture_key));
    CREATE INDEX IF NOT EXISTS history_deleted_id ON history_capture_deletions(user_id,capture_id);
    CREATE TABLE IF NOT EXISTS history_file_gc(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,path TEXT NOT NULL,recursive INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,error TEXT);
    CREATE INDEX IF NOT EXISTS history_gc_owner ON history_file_gc(user_id);`);
  return db;
}
