// Keep the same normalization and character rules as the cloud API.
export function normalizeNickname(value) {
  if (typeof value !== 'string') throw new Error('닉네임을 입력하세요.');
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(name)) {
    throw new Error('닉네임은 2~20자의 한글·영문·숫자·공백·_·-로 입력하세요.');
  }
  return name;
}
