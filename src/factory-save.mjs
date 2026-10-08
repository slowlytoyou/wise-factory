import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultSavePath } from './save.mjs';
import { createFactory, hydrateFactory, serializeFactory } from './factory.mjs';

export const defaultFactoryPath = () => join(dirname(defaultSavePath()), 'factory-v2.json');

export class FactoryStore {
  constructor(file = defaultFactoryPath()) {
    this.file = file;
    this.blocked = false;
    this.lastError = '';
  }

  load(now = Date.now()) {
    const fresh = warning => ({ game: createFactory(now), offlineEarned: 0, offlineSeconds: 0, warning });
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!raw || ![2, 3].includes(raw.version) || !Array.isArray(raw.buildings)) throw new Error('지원하지 않는 공장 저장 형식입니다');
      if (Object.hasOwn(raw, 'contentVersion') && (!Number.isInteger(raw.contentVersion) || raw.contentVersion < 1 || raw.contentVersion > 2)) throw new Error('지원하지 않는 공장 콘텐츠입니다');
      if ((raw.version === 3 || Object.hasOwn(raw, 'progression'))
          && (!raw.progression || typeof raw.progression !== 'object' || Array.isArray(raw.progression) || raw.progression.schema !== 1)) {
        throw new Error('지원하지 않는 성장 저장 형식입니다');
      }
      return { ...hydrateFactory(raw, now), warning: '' };
    } catch (error) {
      if (error.code === 'ENOENT') return fresh('');
      this.blocked = true;
      this.lastError = '저장 파일을 읽을 수 없어 원본을 보존합니다. 다른 --save 경로를 사용하세요.';
      return fresh(this.lastError);
    }
  }

  save(game, now = Date.now()) {
    if (this.blocked) return { ok: false, message: this.lastError };
    let temp;
    let fd;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      temp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(serializeFactory(game, now), null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      temp = undefined;
      this.lastError = '';
      return { ok: true, message: '공장을 저장했습니다.' };
    } catch {
      this.lastError = '공장을 저장하지 못했습니다. 저장 경로와 쓰기 권한을 확인하세요.';
      return { ok: false, message: this.lastError };
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (temp) { try { unlinkSync(temp); } catch {} }
    }
  }
}
