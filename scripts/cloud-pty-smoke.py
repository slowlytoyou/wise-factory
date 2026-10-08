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
import signal
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
import { createFactory, advanceFactory, applyAction, serializeFactory } from %s;
const directory = process.env.STARFALL_TEST_DIRECTORY;
const mode = process.env.STARFALL_TEST_MODE;
const server = createFactory(Date.now());
if (mode.startsWith('leaderboard-')) server.buildings.find(building => building.type === 'belt' && building.x === 18 && building.y === 14).item = 'research_paper';
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
  if ((mode === 'in-flight' && request.actions.length || mode === 'leaderboard-close') && revision === 0) {
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  if (request.revision !== revision) throw new Error('Fixture received an unexpected revision');
  advanceFactory(server, request.activeSeconds ?? 0);
  const results = request.actions.map(action => applyAction(server, action));
  if (results.some(result => !result.ok)) throw new Error('Fixture rejected construction: ' + JSON.stringify(results));
  if (request.nickname !== undefined) nickname = request.nickname;
  revision++;
  persist();
  const response = { state: serializeFactory(server), revision, nickname, results };
  receipts.set(request.requestId, response);
  log({ event: 'commit', requestId: request.requestId, actions: request.actions, nickname: request.nickname, elapsed: server.elapsed, revenue: server.lifetimeRevenue, revision });
  return response;
};
CloudClient.prototype.leaderboard = async function () {
  log({ event: 'leaderboard', nickname, revision, elapsed: server.elapsed, revenue: server.lifetimeRevenue });
  const read = leaderboardReads++;
  if (mode === 'leaderboard-rate-limit' && read === 0) {
    await new Promise(resolve => setTimeout(resolve, 350));
    throw new CloudError('fixture leaderboard rate limit', { status: 429, retryAfterMs: 4200 });
  }
  const rolled = mode === 'month-rollover' && read > 0;
  const me = { rank: 1, nickname, score: mode.startsWith('leaderboard-') ? server.lifetimeRevenue : rolled ? 0 : 1200, goldPerSecond: mode.startsWith('leaderboard-') ? server.lifetimeRevenue / 60 : rolled ? 0 : 2.5 };
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
        game.until(lambda: "실시간 골드/초" in game.text())
        assert "매월 1일 00:00 (한국 시간) 점수 초기화" in game.text()
        game.until(lambda: "2026-11" in game.text(), timeout=5)
        assert len([r for r in game.requests() if r["event"] == "leaderboard"]) == 2
        assert "0 골드/초" in game.text(), "Open leaderboard retained the old month's rate"
        game.send(b"q")
        game.finish()
    print("PASS: open monthly leaderboard refreshes at resetsAt with zeroed score and average rate")


def check_live_leaderboard(directory):
    with Game(directory, "leaderboard-live") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.pump(1.25)
        assert len(game.requests()) == 1, "Live prediction unexpectedly synced before the heartbeat"
        game.send(b"l")
        game.until(lambda: any(entry["event"] == "leaderboard" for entry in game.requests()))
        entries = game.requests()
        first_index = next(i for i, entry in enumerate(entries) if entry["event"] == "leaderboard")
        first = entries[first_index]
        assert first["revenue"] >= 6000 and first["elapsed"] >= 1.2, "Opening L fetched uncommitted earnings"
        assert entries[first_index - 1]["event"] == "commit", "Leaderboard was read before the latest save committed"
        game.send(b"ll")
        game.until(lambda: len([entry for entry in game.requests() if entry["event"] == "leaderboard"]) >= 2, timeout=5)
        boards = [entry for entry in game.requests() if entry["event"] == "leaderboard"]
        assert 2900 <= boards[1]["at"] - boards[0]["at"] < 4800, "Live leaderboard did not automatically refresh every three seconds"
        assert boards[1]["revision"] > boards[0]["revision"] and boards[1]["elapsed"] > boards[0]["elapsed"] + 2.5
        game.until(lambda: "3초 자동 갱신" in game.text())
        game.send(b"l")
        game.pump(.1)
        commits = len([entry for entry in game.requests() if entry["event"] == "commit"])
        game.until(lambda: len([entry for entry in game.requests() if entry["event"] == "commit"]) > commits, timeout=5)
        assert len([entry for entry in game.requests() if entry["event"] == "leaderboard"]) == 2, "Closing L left leaderboard polling active"
        game.send(b"q")
        game.finish()
    print("PASS: L commits recent earnings before reading, refreshes automatically and maintains three-second heartbeats after closing")


def check_leaderboard_rate_limit(directory):
    with Game(directory, "leaderboard-rate-limit") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"l")
        game.until(lambda: any(entry["event"] == "leaderboard" for entry in game.requests()))
        # Close/reopen before the delayed 429 is delivered: its cooldown must
        # survive even though the original panel request became obsolete.
        game.send(b"ll")
        game.until(lambda: "갱신 대기 · 서버 요청 제한" in game.text())
        game.send(b"ll")
        game.pump(3.25)
        assert len([entry for entry in game.requests() if entry["event"] == "leaderboard"]) == 1, "Reopening L bypassed Retry-After"
        game.until(lambda: len([entry for entry in game.requests() if entry["event"] == "leaderboard"]) == 2, timeout=3)
        boards = [entry for entry in game.requests() if entry["event"] == "leaderboard"]
        assert boards[1]["at"] - boards[0]["at"] >= 4180, "Leaderboard retry ignored the server cooldown"
        game.send(b"q")
        game.finish()
    print("PASS: leaderboard 429 preserves Retry-After through close/reopen and recovers without manual input")


def check_leaderboard_close_during_sync(directory):
    with Game(directory, "leaderboard-close") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"l")
        game.until(lambda: len([entry for entry in game.requests() if entry["event"] == "request"]) == 2)
        game.send(b"\x1b")
        game.until(lambda: any(entry["event"] == "commit" for entry in game.requests()))
        game.pump(.2)
        assert not any(entry["event"] == "leaderboard" for entry in game.requests()), "A closed board performed a late leaderboard fetch"
        game.send(b"q")
        game.finish()
    print("PASS: closing L during its save prevents a late leaderboard request")


def check_leaderboard_failed_sync(directory):
    with Game(directory, "network-failure") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"l")
        game.until(lambda: "갱신 지연 · 최신 저장을 확인하지 못했습니다" in game.text())
        assert not any(entry["event"] == "leaderboard" for entry in game.requests()), "Failed sync displayed a misleading live leaderboard"
        game.send(b"q")
        game.finish(code=1)
    print("PASS: unavailable current saves display an explicit stale warning and never claim a live rank")


def check_network_failure(directory):
    with Game(directory, "network-failure") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2eq")
        state = game.finish(code=1)
        assert constructed(state) == [], "Failed server request unexpectedly changed the authoritative save"
        assert "클라우드 저장을 확인하지 못했습니다" in game.text(), "Unconfirmed save was not disclosed"
        assert "클라우드 공장을 저장했습니다" not in game.text(), "Offline exit falsely claimed successful saving"
    print("PASS: failed cloud shutdown reports an unconfirmed save and never claims success")


def check_paused_active_time(directory):
    with Game(directory, "normal") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"p")
        game.until(lambda: "접속 중 생산은 계속됩니다" in game.text())
        game.pump(1.3)
        requests = [entry for entry in game.requests() if entry["event"] == "request"]
        assert len(requests) == 1, "Active frames triggered requests before the periodic sync"
        assert requests[0]["request"]["activeSeconds"] == 0, "Loading the factory awarded active time"
        game.send(b"q")
        state = game.finish()
        assert state["elapsed"] >= 1.2, "Cloud screen pause stopped recording live production time"
        commits = [entry["request"] for entry in game.requests() if entry["event"] == "request" and entry["request"]["revision"] is not None]
        assert abs(state["elapsed"] - sum(request["activeSeconds"] for request in commits)) < .001
    print("PASS: cloud P pauses the display while live time accrues and flushes once on exit")


def check_suspended_active_time(directory):
    with Game(directory, "normal") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"\x1a")
        game.until(lambda: b"\x1b[?1049l" in game.output)
        game.pump(1.6)
        os.kill(game.process.pid, signal.SIGCONT)
        game.until(lambda: game.output.count(b"\x1b[?1049h") == 2)
        game.pump(.15)
        game.send(b"q")
        state = game.finish()
        assert state["elapsed"] < 1, "Terminal suspension was credited as active production"
    print("PASS: terminal suspension and resume do not award elapsed wall time")


def check_disconnected_active_time(directory):
    with Game(directory, "network-failure") as game:
        game.until(lambda: "WISE FACTORY" in game.text())
        game.send(b"2e")
        game.until(lambda: "fixture network unavailable" in game.text())
        first = [entry["request"] for entry in game.requests() if entry["event"] == "request" and entry["request"]["revision"] is not None][0]
        game.pump(1.6)
        game.send(b"q")
        game.finish(code=1)
        requests = [entry["request"] for entry in game.requests() if entry["event"] == "request" and entry["request"]["revision"] is not None]
        assert requests == [first, first], "Disconnected frames changed the immutable retry payload"
        cache = json.loads((game.personal.parent / "factory-cloud-cache.json").read_text())
        assert cache["elapsed"] <= first["activeSeconds"] + .1, "Disconnected production kept advancing in the display"
    print("PASS: lost connections freeze production and never add disconnected time to a retry")


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
        check_live_leaderboard(root / "live-leaderboard")
        check_leaderboard_rate_limit(root / "leaderboard-rate-limit")
        check_leaderboard_close_during_sync(root / "leaderboard-close")
        check_leaderboard_failed_sync(root / "leaderboard-failed-sync")
        check_network_failure(root / "network-failure")
        check_rate_limit_recovery(root / "rate-limit")
        check_paused_active_time(root / "paused-time")
        check_suspended_active_time(root / "suspended-time")
        check_disconnected_active_time(root / "disconnected-time")
    print("All cloud PTY checks passed.")
