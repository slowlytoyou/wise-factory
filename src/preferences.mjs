import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultFactoryPath } from './factory-save.mjs';
import { SKINS, getSkin } from './skins.mjs';

export const defaultPreferencesPath = () => join(dirname(defaultFactoryPath()), 'preferences.json');

/** Device preferences are independent of factory saves and cloud accounts. */
export class PreferencesStore {
  constructor(file = defaultPreferencesPath()) {
    this.file = file;
    this.loaded = false;
    this.blocked = false;
    this.lastError = '';
    this.skin = 'original';
  }

  load() {
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1
          || typeof raw.skin !== 'string' || Object.keys(raw).some(key => !['version', 'skin'].includes(key))) {
        throw new Error('Unsupported preferences');
      }
      this.skin = getSkin(raw.skin).id;
      return { skin: this.skin, warning: '' };
    } catch (error) {
      if (error.code === 'ENOENT') return { skin: 'original', warning: '' };
      this.blocked = true;
      this.lastError = '스킨 설정 파일을 읽을 수 없어 원본을 보존합니다. 변경은 이번 실행에만 적용됩니다.';
      return { skin: 'original', warning: this.lastError };
    }
  }

  save(skin) {
    // Even callers that skipped load must never overwrite an unrelated file.
    if (!this.loaded) this.load();
    if (this.blocked) return { ok: false, message: this.lastError };
    if (!SKINS.some(choice => choice.id === skin)) return { ok: false, message: '지원하지 않는 스킨입니다.' };
    let temp, fd;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      temp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, skin }, null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      temp = undefined;
      this.skin = skin;
      this.lastError = '';
      return { ok: true, message: '스킨 설정을 저장했습니다.' };
    } catch {
      this.lastError = '스킨 설정을 저장하지 못했습니다. 변경은 이번 실행에만 적용됩니다.';
      return { ok: false, message: this.lastError };
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (temp) { try { unlinkSync(temp); } catch {} }
    }
  }
}
