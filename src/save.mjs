import {
  readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync,
  closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createGame, hydrateGame, serializeGame } from './model.mjs';

export function defaultSavePath() {
  const stateHome = process.env.XDG_STATE_HOME;
  const base = stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), '.local', 'state');
  return join(base, 'starfall', 'save.json');
}

function errorReason(error) {
  switch (error?.code) {
    case 'EACCES':
    case 'EPERM': return '파일에 접근할 권한이 없어요';
    case 'ENOSPC': return '저장 공간이 부족해요';
    case 'EROFS': return '읽기 전용 경로예요';
    case 'ENOTDIR': return '저장 경로의 상위 항목이 폴더가 아니에요';
    case 'EISDIR': return '저장 파일 경로가 폴더를 가리키고 있어요';
    case 'ENOENT': return '저장 경로를 찾을 수 없어요';
    default: return `파일 작업에 실패했어요${error?.code ? ` (${error.code})` : ''}`;
  }
}

/** Synchronous, atomic local saves. Failed reads never authorize overwriting. */
export class SaveStore {
  constructor(file = defaultSavePath()) {
    this.file = resolve(file);
    this.blocked = false;
    this.lastError = null;
  }

  load(now = Date.now()) {
    this.blocked = false;
    this.lastError = null;
    const fresh = () => ({ game: createGame(now), offlineEarned: 0, offlineSeconds: 0, warning: null });
    const block = reason => {
      this.blocked = true;
      this.lastError = `저장 파일을 보존하기 위해 저장을 중단했어요: ${reason}. 다른 --save 경로로 실행해 주세요.`;
      return { ...fresh(), warning: this.lastError };
    };

    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return fresh();
      return block(errorReason(error));
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return block('JSON 형식이 손상되었어요');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return block('올바른 게임 저장 데이터가 아니에요');
    }
    if (raw.version !== 1) return block('지원하지 않는 저장 버전이에요');

    try {
      return { ...hydrateGame(raw, now), warning: null };
    } catch {
      return block('게임 데이터를 읽을 수 없어요');
    }
  }

  save(game, now = Date.now()) {
    if (this.blocked) return { ok: false, message: this.lastError };
    let temporaryFile;
    let descriptor;
    let created = false;
    try {
      const serialized = `${JSON.stringify(serializeGame(game, now), null, 2)}\n`;
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      temporaryFile = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      descriptor = openSync(temporaryFile, 'wx', 0o600);
      created = true;
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryFile, this.file);
      created = false;
      this.lastError = null;
      return { ok: true, message: '진행 상황을 저장했어요.' };
    } catch (error) {
      this.lastError = `저장하지 못했어요: ${errorReason(error)}. 다른 --save 경로를 사용할 수 있어요.`;
      return { ok: false, message: this.lastError };
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* Preserve the original error. */ }
      }
      if (created) {
        try { unlinkSync(temporaryFile); } catch { /* A failed cleanup cannot crash play. */ }
      }
    }
  }
}
