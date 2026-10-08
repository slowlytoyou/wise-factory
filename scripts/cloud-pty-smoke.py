#!/usr/bin/env python3
"""Cloud CLI lifecycle checks using a fake server and the real CloudGame.

Only Python's standard library is required. Authentication, network calls and
server persistence are replaced in a temporary Node preload; personal saves and
all test artifacts remain in a disposable directory.
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def prepare(directory, mode):
    directory.mkdir()
    personal = directory / "state" / "starfall" / "factory-v2.json"
    personal.parent.mkdir(parents=True)
    personal.write_text('{"personal":"preserve every byte"}\n')
    preload = directory / "fake-cloud.mjs"
    preload.write_text("""
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudClient, CloudError } from %s;
import { createFactory, applyAction, serializeFactory } from %s;
const directory = process.env.STARFALL_TEST_DIRECTORY;
const mode = process.env.STARFALL_TEST_MODE;
const server = createFactory(Date.now());
const receipts = new Map();
let revision = 0;
let nickname = 'PTY fixture';
let rateLimitSent = false;
let leaderboardReads = 0;
const log = value => appendFileSync(join(directory, 'requests.jsonl'), JSON.stringify({ ...value, at: Date.now() }) + '\\n');
const persist = () => {
  writeFileSync(join(directory, 'server.json'), JSON.stringify(serializeFactory(server)));
  writeFileSync(join(directory, 'profile.json'), JSON.stringify({ nickname }));
};
globalThis.fetch = async () => { throw new Error('Unexpected real network request'); };
CloudClient.prototype.loadSession = async function () {
  this.session = { access_token: 'fixture', refresh_token: 'fixture', expires_at: Date.now() / 1000 + 3600 };
  return true;
};
CloudClient.prototype.sync = async function (request) {
  log({ event: 'request', request });
  if (request.revision === null) {
    if (request.nickname !== undefined) nickname = request.nickname;
    persist();
    return { state: serializeFactory(server), revision, nickname, results: [] };
  }
  if (mode === 'network-failure') throw new CloudError('fixture network unavailable', { code: 'network_error' });
  if (mode === 'rate-limit' && request.actions.length && !rateLimitSent) {
    rateLimitSent = true;
    throw new CloudError('fixture request rate limit', { status: 429, code: 'rate_limited', retryAfterMs: 800 });
  }
  if (receipts.has(request.requestId)) return { ...receipts.get(request.requestId), replayed: true };
  if (mode === 'in-flight' && request.actions.length && revision === 0) {
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  if (request.revision !== revision) throw new Error('Fixture received an unexpected revision');
  const results = request.actions.map(action => applyAction(server, action));
  if (results.some(result => !result.ok)) throw new Error('Fixture rejected construction: ' + JSON.stringify(results));
  if (request.nickname !== undefined) nickname = request.nickname;
  revision++;
  persist();
  const response = { state: serializeFactory(server), revision, nickname, results };
  receipts.set(request.requestId, response);
  log({ event: 'commit', requestId: request.requestId, actions: request.actions, nickname: request.nickname });
  return response;
};
CloudClient.prototype.leaderboard = async function () {
  log({ event: 'leaderboard', nickname });
  const rolled = mode === 'month-rollover' && leaderboardReads++ > 0;
  const me = { rank: 1, nickname, score: rolled ? 0 : 1200, goldPerSecond: rolled ? 0 : 2.5 };
  return { entries: [me], me, month: rolled ? '2026-11' : '2026-10', resetsAt: new Date(Date.now() + (mode === 'month-rollover' && !rolled ? 1000 : 31 * 86400000)).toISOString(), timezone: 'Asia/Seoul' };
};
""" % (json.dumps((ROOT / "src" / "cloud.mjs").as_uri()),
           json.dumps((ROOT / "src" / "factory.mjs").as_uri())))
    return preload, personal


class Game:
    def __init__(self, directory, mode):
        preload, self.personal = prepare(directory, mode)
        self.directory = directory
        self.master, self.slave = pty.openpty()
        self.original_termios = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.output = bytearray()
        environment = dict(os.environ, TERM="xterm-256color", XDG_STATE_HOME=str(directory / "state"),
                           SUPABASE_URL="https://pty-fixture.supabase.co", SUPABASE_PUBLISHABLE_KEY="sb_publishable_fixture",
                           STARFALL_TEST_DIRECTORY=str(directory), STARFALL_TEST_MODE=mode)
        environment.pop("NODE_OPTIONS", None)
        self.process = subprocess.Popen([NODE, "--import", str(preload), str(ROOT / "src" / "main.mjs"), "--cloud", "--no-color"],
                                        cwd=directory, env=environment, stdin=self.slave, stdout=self.slave, stderr=self.slave)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)

    def pump(self, seconds=0.05):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            self.output.extend(data)

    def text(self):
        return ANSI.sub(b"", bytes(self.output)).decode("utf-8", errors="replace")

    def until(self, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        while not predicate():
            self.pump()
            if self.process.poll() is not None or time.monotonic() >= deadline:
                assert predicate(), f"Timed out; exit={self.process.poll()}; output={self.text()[-1500:]!r}"

    def send(self, keys):
        os.write(self.master, keys)

    def requests(self):
        path = self.directory / "requests.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def finish(self, code=0):
        self.until(lambda: self.process.poll() is not None, timeout=8)
        self.pump()
        assert self.process.returncode == code, f"Exit {self.process.returncode} != {code}: {self.text()[-1500:]}"
        assert termios.tcgetattr(self.slave) == self.original_termios, "Raw mode was not restored"
        for restored, hidden in [(b"\x1b[?1049l", b"\x1b[?1049h"), (b"\x1b[?25h", b"\x1b[?25l"), (b"\x1b[?7h", b"\x1b[?7l")]:
            assert self.output.rfind(restored) > self.output.rfind(hidden) >= 0, "Terminal state was not restored"
        assert self.personal.read_text() == '{"personal":"preserve every byte"}\n', "Cloud mode changed the personal save"
        assert "Unexpected real network request" not in self.text()
        return json.loads((self.directory / "server.json").read_text())


def constructed(state):
    return [(building["x"], building["y"]) for building in state["buildings"] if building["y"] == 16]


def check_immediate_exit(directory):
    with Game(directory, "normal") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2eq")
        state = game.finish()
        assert constructed(state) == [(17, 16)], "Immediate exit lost the queued build"
        requests = [entry for entry in game.requests() if entry["event"] == "request"]
        assert len(requests) == 2, "Unexpected duplicate or missing sync"
        assert requests[1]["at"] - requests[0]["at"] >= 580, "Shutdown bypassed the cloud cooldown"
        assert "클라우드 공장을 저장했습니다" in game.text()
        assert "클라우드 저장을 확인하지 못했습니다" not in game.text()
    print("PASS: immediate cloud exit waits for cooldown, confirms queued construction and preserves personal save")


def check_in_flight_exit(directory):
    with Game(directory, "in-flight") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2e")
        game.until(lambda: any(entry["event"] == "request" and entry["request"]["actions"] for entry in game.requests()))
        game.send(b"deq")
        state = game.finish()
        assert constructed(state) == [(17, 16), (18, 16)], "Exit did not flush the action queued during an in-flight sync"
        commits = [entry for entry in game.requests() if entry["event"] == "commit"]
        assert sum(len(entry["actions"]) for entry in commits) == 2, "Construction was duplicated"
        assert "클라우드 공장을 저장했습니다" in game.text()
    print("PASS: exit drains a build queued during an in-flight sync exactly once")


def check_nickname_exit(directory):
    with Game(directory, "normal") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"n")
        game.until(lambda: "NICKNAME / 닉네임 설정" in game.text())
        assert "리더보드에 공개" in game.text(), "Cloud nickname visibility was not explained"
        game.send(b"\x15" + "별빛-qwasd".encode() + b"\rq")
        state = game.finish()
        assert constructed(state) == [], "Nickname typing triggered factory construction"
        assert state["player"] == {"x": 17, "y": 16}, "Nickname typing moved the player"
        profile = json.loads((directory / "profile.json").read_text())
        assert profile["nickname"] == "별빛-qwasd", "Immediate exit lost the nickname update"
        requests = [entry for entry in game.requests() if entry["event"] == "request"]
        assert len(requests) == 2, "Unexpected duplicate or missing nickname sync"
        assert requests[1]["request"]["nickname"] == "별빛-qwasd"
        assert requests[1]["request"]["actions"] == []
        assert requests[1]["at"] - requests[0]["at"] >= 580, "Nickname shutdown bypassed the cloud cooldown"
        commits = [entry for entry in game.requests() if entry["event"] == "commit"]
        assert len(commits) == 1 and commits[0]["nickname"] == "별빛-qwasd"
        assert "클라우드 공장을 저장했습니다" in game.text()
    print("PASS: cloud nickname save followed by immediate Q confirms metadata once and preserves personal save")


def check_nickname_leaderboard(directory):
    with Game(directory, "normal") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"n\x15Rank_Factory\r")
        game.until(lambda: any(entry["event"] == "commit" and entry.get("nickname") == "Rank_Factory" for entry in game.requests()))
        game.send(b"l")
        game.until(lambda: any(entry["event"] == "leaderboard" for entry in game.requests()))
        game.until(lambda: "내 공장 #1  Rank_Factory" in game.text())
        game.send(b"q")
        game.finish()
        assert json.loads((directory / "profile.json").read_text())["nickname"] == "Rank_Factory"
    print("PASS: confirmed cloud nickname appears in the leaderboard after editing")


def check_monthly_leaderboard(directory):
    with Game(directory, "month-rollover") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"l")
        game.until(lambda: "2026-10" in game.text())
        game.until(lambda: "초당 평균 골드 생산량" in game.text())
        assert "매월 1일 00:00 (한국 시간) 점수 초기화" in game.text()
        game.until(lambda: "2026-11" in game.text(), timeout=5)
        assert len([r for r in game.requests() if r["event"] == "leaderboard"]) == 2
        assert "0 골드/초" in game.text(), "Open leaderboard retained the old month's rate"
        game.send(b"q")
        game.finish()
    print("PASS: open monthly leaderboard refreshes at resetsAt with zeroed score and average rate")


def check_network_failure(directory):
    with Game(directory, "network-failure") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2eq")
        state = game.finish(code=1)
        assert constructed(state) == [], "Failed server request unexpectedly changed the authoritative save"
        assert "클라우드 저장을 확인하지 못했습니다" in game.text(), "Unconfirmed save was not disclosed"
        assert "클라우드 공장을 저장했습니다" not in game.text(), "Offline exit falsely claimed successful saving"
    print("PASS: failed cloud shutdown reports an unconfirmed save and never claims success")


def check_rate_limit_recovery(directory):
    with Game(directory, "rate-limit") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2e")
        # No G or other input: the UI must schedule recovery by itself.
        game.until(lambda: any(entry["event"] == "commit" and entry["actions"] for entry in game.requests()), timeout=5)
        requests = [entry for entry in game.requests() if entry["event"] == "request"]
        assert len(requests) == 3, "Automatic recovery produced duplicate requests or failed to retry"
        first, retry = requests[1:]
        assert first["request"] == retry["request"], "Rate-limit retry changed the pending request or UUID"
        assert retry["at"] - first["at"] >= 780, "Automatic retry ignored Retry-After"
        assert "자동으로 재시도" in game.text(), "Rate-limit wait was not explained"
        game.send(b"q")
        state = game.finish()
        assert constructed(state) == [(17, 16)], "Rate-limit recovery lost or duplicated construction"
        entries = game.requests()
        assert len([entry for entry in entries if entry["event"] == "request"]) <= 4, "Recovery or shutdown caused a retry loop"
        assert sum(len(entry["actions"]) for entry in entries if entry["event"] == "commit") == 1
        assert "클라우드 공장을 저장했습니다" in game.text()
        assert "클라우드 저장을 확인하지 못했습니다" not in game.text()
    print("PASS: automatic 429 recovery honors delay, retries the exact request and commits the build once without G")


if __name__ == "__main__":
    if NODE is None:
        raise SystemExit("Node.js 20+ must be on PATH")
    with tempfile.TemporaryDirectory(prefix="starfall-cloud-pty-") as temporary:
        root = Path(temporary)
        check_immediate_exit(root / "immediate")
        check_in_flight_exit(root / "in-flight")
        check_nickname_exit(root / "nickname-exit")
        check_nickname_leaderboard(root / "nickname-leaderboard")
        check_monthly_leaderboard(root / "monthly-leaderboard")
        check_network_failure(root / "network-failure")
        check_rate_limit_recovery(root / "rate-limit")
    print("All cloud PTY checks passed.")
