#!/usr/bin/env python3
"""Factory v2 POSIX terminal integration checks; Python standard library only.

Run from any directory: python3 scripts/pty-smoke.py
All game saves and named pipes are confined to a disposable temporary directory.
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


class Game:
    def __init__(self, directory, *arguments, terminal="xterm-256color", extra_env=None):
        self.master, self.slave = pty.openpty()
        self.original_termios = termios.tcgetattr(self.slave)
        self.resize(120, 40, notify=False)
        self.output = bytearray()
        environment = dict(os.environ, TERM=terminal, XDG_STATE_HOME=str(directory / "state"))
        environment.update(extra_env or {})
        self.process = subprocess.Popen(
            [NODE, str(ROOT / "src/main.mjs"), "--no-color", *arguments],
            stdin=self.slave, stdout=self.slave, stderr=self.slave,
            cwd=directory, env=environment, close_fds=True,
        )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)

    def resize(self, columns, rows, notify=True):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        if notify:
            self.process.send_signal(signal.SIGWINCH)

    def pump(self, seconds=0.15):
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

    def text(self, after=0):
        return ANSI.sub(b"", bytes(self.output[after:])).decode("utf-8", errors="replace")

    def expect(self, fragment, after=0, timeout=4):
        deadline = time.monotonic() + timeout
        while fragment not in self.text(after):
            self.pump(0.05)
            if self.process.poll() is not None or time.monotonic() >= deadline:
                raise AssertionError(f"Missing {fragment!r}; exit={self.process.poll()}; tail={self.text(after)[-1200:]!r}")

    def send(self, keys):
        marker = len(self.output)
        os.write(self.master, keys)
        return marker

    def finish(self, keys=b"q", code=0):
        self.send(keys)
        deadline = time.monotonic() + 4
        while self.process.poll() is None and time.monotonic() < deadline:
            self.pump(0.05)
        assert self.process.poll() == code, f"Game did not exit as expected: {self.process.poll()} != {code}"
        self.pump(0.05)
        output = bytes(self.output)
        assert b"\x1b[?1049h" in output, "Alternate screen was not enabled"
        assert b"\x1b[?25l" in output, "Cursor was not hidden"
        assert output.rfind(b"\x1b[?25h") > output.rfind(b"\x1b[?25l"), "Cursor was not restored after the last entry"
        assert output.rfind(b"\x1b[?7h") > output.rfind(b"\x1b[?7l"), "Line wrapping was not restored after the last entry"
        assert output.rfind(b"\x1b[?1049l") > output.rfind(b"\x1b[?1049h"), "Alternate screen was not disabled after the last entry"
        assert termios.tcgetattr(self.slave) == self.original_termios, "Raw terminal settings were not restored"
        assert b"38;2;" not in output, "--no-color emitted RGB color sequences"


def check_gameplay(directory):
    save = directory / "play.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        game.expect("M 중앙 상인")
        assert not save.exists(), "Startup unexpectedly wrote a save"

        # Make a round trip with all four movement keys before building.
        for key, position in [(b"w", "(17,15)"), (b"a", "(16,15)"), (b"s", "(16,16)"), (b"d", "(17,16)")]:
            marker = game.send(key)
            game.expect(position, marker)
        marker = game.send(b"2e")
        game.expect("컨베이어 설치", marker)
        game.expect("컨베이어  Lv.1", marker)
        marker = game.send(b"u")
        game.expect("컨베이어 Lv.2", marker)
        marker = game.send(b"r")
        game.expect("출력 방향 회전", marker)
        game.expect("@ 17,16  배출 ↓", marker)
        marker = game.send(b"x")
        game.expect("설비 회수 +3코인", marker)
        marker = game.send(b"ds")
        game.expect("(18,17)", marker)

        marker = game.send(b"p")
        game.expect("일시 정지", marker)
        game.send(b"2euwasdx")  # Construction and movement must be ignored while paused.

        marker = game.send(b"c")
        game.expect("PRODUCTION ATLAS", marker)
        game.expect("엔진 조립", marker)
        game.expect("강철 ×2 + 기어 ×2 + 회로 ×1", marker)
        game.send(b"c")
        game.pump()
        marker = game.send(b"l")
        game.expect("LOCAL RECORD", marker)
        game.expect("내 공장 기록", marker)
        game.send(b"l")
        game.pump()
        marker = game.send(b"?")
        game.expect("FIELD MANUAL", marker)
        game.expect("E / SPACE", marker)
        game.send(b"?")
        game.pump()
        marker = len(game.output)
        game.resize(70, 24)
        game.expect("88열 × 30행", marker)
        marker = len(game.output)
        game.resize(88, 30)
        game.expect("WISE FACTORY", marker)
        game.expect("[X] 철거", marker)
        game.expect("[Q] 종료", marker)
        game.finish()
    data = json.loads(save.read_text())
    assert data["version"] == 3
    assert data["player"] == {"x": 18, "y": 17}, data["player"]
    assert len(data["buildings"]) == 7, data["buildings"]
    assert all(building["y"] == 14 for building in data["buildings"]), "Paused input changed the world"
    # Revenue may accrue on a slow machine; subtracting it makes costs exact.
    assert data["coins"] - data["lifetimeRevenue"] == 296, data
    assert data["savedAt"] > 0
    print("PASS: WASD, build, upgrade, rotate, salvage, pause, modals, resize and terminal restoration")


def check_recipes(directory):
    save = directory / "recipes.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        marker = game.send(b"3e")
        game.expect("설계도", marker)
        marker = game.send(b"b")
        game.expect("인접 칸", marker)
        marker = game.send(b"db")  # One step toward the merchant reaches the shop boundary.
        game.expect("용광로 설계도", marker)
        game.send(b"1e")
        game.pump()
        game.send(b"e")  # Buying the same blueprint twice must not charge again.
        game.pump()
        game.send(b"\x1b")
        game.pump(0.6)  # readline waits to distinguish lone Escape from a key sequence.
        game.send(b"a")
        game.pump()
        marker = game.send(b"3 ")
        game.expect("용광로 설치", marker)
        game.expect("용광로  Lv.1", marker)
        marker = game.send(b"f")
        game.expect("구리판 제련", marker)
        game.expect("조합법 변경", marker)
        marker = game.send(b"f")
        game.expect("강철 제련", marker)
        game.expect("철판 ×2 + 석탄 ×1", marker)
        game.finish()
    data = json.loads(save.read_text())
    machine = next(building for building in data["buildings"] if building["x"] == 17 and building["y"] == 16)
    assert machine["type"] == "smelter" and machine["recipe"] == "steel", machine
    assert data["coins"] - data["lifetimeRevenue"] == 10, data
    assert data["progression"]["unlocks"] == {"smelter": True, "assembler": False}
    print("PASS: locked construction, merchant proximity, one-time blueprint purchase, SPACE build and recipes")


def progression_fixture(save, body):
    fixture = subprocess.run(
        [NODE, "--input-type=module", "-e", "import {createFactory,serializeFactory} from './src/factory.mjs'; const game=createFactory();\n" + body + "\nprocess.stdout.write(JSON.stringify(serializeFactory(game)));"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    save.write_text(fixture.stdout)


def check_shop_and_transmitter(directory):
    save = directory / "shop.json"
    progression_fixture(save, "game.coins=3000; game.player={x:18,y:16};")
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        marker = game.send(b"b")
        game.expect("구리 탐지 레이더", marker)
        game.send(b"3\r")  # Radar discovery and one transmitter purchased with Enter.
        game.pump()
        game.send(b"5\r")
        game.pump()
        game.send(b"\x1b")
        game.pump(0.6)
        marker = game.send(b"5e")
        game.expect("전송기 설치", marker)
        marker = game.send(b"x")
        game.expect("재고 +1", marker)
        marker = game.send(b"e")
        game.expect("전송기 설치", marker)
        marker = game.send(b"ae")
        game.expect("판매 전송기를 구매", marker)  # A second placement needs another purchased unit.
        game.finish()
    data = json.loads(save.read_text())
    assert data["progression"]["radarLevel"] == 1
    assert data["progression"]["transmitters"] == 0
    assert sum(b["type"] == "transmitter" for b in data["buildings"]) == 1
    assert data["coins"] - data["lifetimeRevenue"] == 2400, data
    print("PASS: radar purchase, Enter checkout, transmitter placement, inventory recovery and no free duplicate")


def check_catalog_navigation(directory):
    save = directory / "catalog.json"
    progression_fixture(save, "game.coins=20000; game.player={x:18,y:16}; game.progression.radarLevel=2;")
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        game.resize(88, 30)
        game.pump()
        marker = game.send(b"c")
        game.expect("1/4 페이지", marker)
        marker = game.send(b"d")
        game.expect("2/4 페이지", marker)
        game.expect("엔진 조립", marker)
        marker = game.send(b"\x1b[F")
        game.expect("4/4 페이지", marker)
        game.expect("논문 집필", marker)
        game.expect("실험데이터 ×2 + 종이 ×3 + 반도체 ×1", marker)
        marker = game.send(b"\r")
        game.expect("제작법 선택: 논문 집필", marker)
        marker = game.send(b"b")
        game.expect("1/2 페이지", marker)
        marker = game.send(b"d")
        game.expect("2/2 페이지", marker)
        game.expect("원목 탐지 레이더", marker)
        game.expect("금 탐지 레이더", marker)
        game.send(b"6\rss")  # First new radar, then navigate to the last offer.
        game.pump()
        marker = game.send(b"w\r")
        game.expect("구매 완료", marker)
        marker = game.send(b"s\r")
        game.expect("구매 완료", marker)
        game.send(b"b")
        game.pump()
        game.finish()
    data = json.loads(save.read_text())
    assert data["progression"]["radarLevel"] == 5
    assert data["player"] == {"x": 18, "y": 16}, "Catalog navigation moved the world cursor"
    assert data["coins"] - data["lifetimeRevenue"] == 7400
    print("PASS: minimum-size atlas/shop paging, final paper selection and all three new radars")


def check_prestige(directory):
    save = directory / "prestige.json"
    progression_fixture(save, "game.coins=2000; game.lifetimeRevenue=20000; game.progression.runRevenue=20000; game.progression.unlocks={smelter:true,assembler:true}; game.progression.radarLevel=2; game.progression.transmitters=3;")
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        marker = game.send(b"t")
        game.expect("OH CORE", marker)
        marker = game.send(b"e")
        game.expect("[Y]", marker)
        game.send(b"\x1b")
        game.pump(0.6)
        game.send(b"y")  # Escape cancels and stray Y never resets the factory.
        game.pump()
        marker = game.send(b"t")
        game.expect("OH CORE", marker)
        game.send(b"\r")
        game.pump()
        game.send(b"y")
        game.pump()
        game.finish()
    data = json.loads(save.read_text())
    p = data["progression"]
    assert p["prestigeCount"] == 1 and p["cores"] == 2, p
    assert p["runRevenue"] < 20, p
    assert p["unlocks"] == {"smelter": False, "assembler": False}
    assert p["radarLevel"] == 0 and p["transmitters"] == 0
    assert data["coins"] - p["runRevenue"] == 300
    assert data["lifetimeRevenue"] >= 20000 and len(data["buildings"]) == 7
    # Reopening persists earned cores and cannot prestige a second time immediately.
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        game.send(b"tey")
        game.pump()
        game.finish()
    assert json.loads(save.read_text())["progression"]["prestigeCount"] == 1
    print("PASS: prestige preview, cancellation, two-step confirmation, reset, retained cores and reload")


def check_demo(directory):
    # A read from this FIFO would block forever; starting proves demo skips save reads.
    fifo = directory / "demo-save.fifo"
    os.mkfifo(fifo)
    before = sorted(path.name for path in directory.iterdir())
    with Game(directory, "--demo", "--save", str(fifo)) as game:
        game.expect("DEMO")
        game.expect("진행 상황 저장 안 함")
        game.finish()
    assert fifo.is_fifo(), "Demo replaced the nominated save"
    assert sorted(path.name for path in directory.iterdir()) == before, "Demo created files"
    print("PASS: demo neither reads nor writes save storage")


def check_nickname(directory):
    save = directory / "nickname.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        marker = game.send(b"n")
        game.expect("NICKNAME / 닉네임 설정", marker)
        game.expect("개인 닉네임", marker)
        marker = game.send(b"\x15wasdqhr2e\r")
        game.expect("닉네임 저장 완료 · wasdqhr2e", marker)
        state = json.loads(save.read_text())
        assert state["nickname"] == "wasdqhr2e"
        assert state["player"] == {"x": 17, "y": 16}, "Typing WASD moved the player"
        assert len(state["buildings"]) == 7, "Typing construction shortcuts changed the factory"
        assert state["coins"] - state["lifetimeRevenue"] == 300

        # UTF-8 text and backspace edit one grapheme; Enter persists immediately.
        marker = game.send(b"n\x15" + "별빛공장각".encode() + b"\x7f\r")
        game.expect("닉네임 저장 완료 · 별빛공장", marker)
        assert json.loads(save.read_text())["nickname"] == "별빛공장"

        marker = game.send(b"n\x15a\r")
        game.expect("닉네임은 2~20", marker)
        marker = game.send(b"q")
        game.expect("> aq", marker)
        assert game.process.poll() is None, "Invalid input dismissed the editor and Q exited"
        assert json.loads(save.read_text())["nickname"] == "별빛공장", "Invalid draft replaced the saved name"
        game.send(b"\x1b")
        game.pump(0.6)
        game.finish()

    with Game(directory, "--save", str(save)) as game:
        game.expect("[N] 별빛공장")
        marker = game.send(b"n")
        game.expect("현재 이름  별빛공장", marker)
        game.send(b"\x15cancelled-name\x1b")
        game.pump(0.6)
        game.finish()
    assert json.loads(save.read_text())["nickname"] == "별빛공장", "Escape saved a cancelled draft"
    print("PASS: nickname editor isolates shortcuts, edits Korean, rejects invalid names, saves locally, reloads and cancels")


def check_ctrl_c(directory):
    save = directory / "interrupt.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        marker = game.send(b"2e")
        game.expect("컨베이어 설치", marker)
        marker = game.send(b"n\x15unsaved-name")
        game.expect("NICKNAME / 닉네임 설정", marker)
        game.finish(b"\x03")
    data = json.loads(save.read_text())
    assert data["nickname"] == "공장장", "Ctrl-C committed an unsaved nickname draft"
    assert len(data["buildings"]) == 8
    assert any(building["type"] == "belt" and building["x"] == 17 and building["y"] == 16 for building in data["buildings"])
    print("PASS: Ctrl-C inside nickname editor saves progress, discards the draft, restores terminal and exits")


def check_sigcont(directory):
    with Game(directory, "--demo") as game:
        game.expect("DEMO")
        game.process.send_signal(signal.SIGCONT)
        game.pump()
        game.finish()
    print("PASS: unsolicited SIGCONT does not leave an interval keeping the process alive")


def check_suspend_resume(directory):
    save = directory / "suspend.json"
    # One packet at the merchant makes production while suspended observable.
    fixture = subprocess.run(
        [NODE, "--input-type=module", "-e", """
import { createFactory, serializeFactory } from './src/factory.mjs';
const game = createFactory();
game.buildings.find(building => building.type === 'belt' && building.x === 18).item = 'iron_ore';
process.stdout.write(JSON.stringify(serializeFactory(game)));
"""], cwd=ROOT, check=True, capture_output=True, text=True,
    )
    save.write_text(fixture.stdout)
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        game.send(b"\x1a")
        deadline = time.monotonic() + 3
        stopped = False
        while time.monotonic() < deadline:
            game.pump(0.05)
            _, status = os.waitpid(game.process.pid, os.WUNTRACED | os.WNOHANG)
            if os.WIFSTOPPED(status):
                stopped = True
                break
        assert stopped, "Ctrl-Z did not suspend the game"
        assert termios.tcgetattr(game.slave) == game.original_termios
        assert b"\x1b[?1049l" in game.output
        before = json.loads(save.read_text())
        game.pump(1.2)
        marker = len(game.output)
        game.process.send_signal(signal.SIGCONT)
        game.expect("WISE FACTORY", marker)
        assert termios.tcgetattr(game.slave) != game.original_termios
        game.finish()
    after = json.loads(save.read_text())
    assert after["elapsed"] >= before["elapsed"] + 1.1
    assert after["lifetimeRevenue"] >= 2, after
    assert after["coins"] >= before["coins"]
    print("PASS: Ctrl-Z restores the shell, resume restores play and credits suspended production")


def check_corrupt_save(directory):
    save = directory / "corrupt.json"
    original = b'{"version":2,"buildings":[\n'
    save.write_bytes(original)
    with Game(directory, "--save", str(save)) as game:
        game.expect("저장")
        game.finish(code=1)
    assert save.read_bytes() == original
    assert "저장하지 못했습니다" in game.text()
    print("PASS: damaged v2 save survives shutdown and failed saving still restores the terminal")


def check_termination_signal(directory):
    save = directory / "sigterm.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("WISE FACTORY")
        game.process.send_signal(signal.SIGTERM)
        game.finish(keys=b"", code=143)
    assert json.loads(save.read_text())["version"] == 3
    print("PASS: SIGTERM saves, restores the terminal and exits with status 143")


def check_dumb_terminal(directory):
    with Game(directory, terminal="dumb") as game:
        game.process.wait(timeout=3)
        game.pump()
        assert game.process.returncode == 1
        assert "대화형 터미널" in game.text()
        assert b"\x1b[?1049h" not in game.output
        assert termios.tcgetattr(game.slave) == game.original_termios
    print("PASS: TERM=dumb is rejected without entering raw mode")


def check_private_local_mode(directory):
    # Trap all cloud I/O so the assertion also fails if a caught error hides access.
    marker = directory / "unexpected-cloud-access.txt"
    hook = directory / "deny-cloud.mjs"
    hook.write_text("""
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const marker = """ + json.dumps(str(marker)) + """;
const record = what => { fs.appendFileSync(marker, what + '\\n'); throw new Error('Unexpected cloud access: ' + what); };
globalThis.fetch = () => record('network');
const readSync = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (String(path).endsWith('/config/cloud.json')) return record('cloud-config');
  return readSync.call(this, path, ...args);
};
const readAsync = fsp.readFile;
fsp.readFile = async function(path, ...args) {
  if (String(path).includes('/starfall-idle/cloud/')) return record('login-session');
  return readAsync.call(this, path, ...args);
};
syncBuiltinESMExports();
""")
    environment = {"NODE_OPTIONS": '--import="' + str(hook) + '"', "SUPABASE_URL": "bad-url", "SUPABASE_PUBLISHABLE_KEY": "sb_secret_rejected_if_read"}
    for name, flags in [("default", []), ("explicit", ["--local"])]:
        save = directory / (name + "-private.json")
        with Game(directory, *flags, "--save", str(save), extra_env=environment) as game:
            game.expect("LOCAL PLAY")
            game.send(b"2e")
            game.pump()
            game.send(b"l")
            game.expect("LOCAL RECORD")
            game.send(b"l")
            game.pump()
            game.send(b"n\x15" + ("Private_" + name).encode() + b"\r")
            game.expect("닉네임 저장 완료 · Private_" + name)
            game.send(b"g")
            game.pump()
            game.finish()
        assert any(b["type"] == "belt" and b["x"] == 17 and b["y"] == 16 for b in json.loads(save.read_text())["buildings"])
        assert json.loads(save.read_text())["nickname"] == "Private_" + name
        assert "npm run login" not in game.text() and "Supabase" not in game.text()
        assert not marker.exists(), marker.read_text() if marker.exists() else ""
    print("PASS: default/explicit private play, nickname, local records and save with cloud config/session/network access forbidden")


if __name__ == "__main__":
    if NODE is None:
        raise SystemExit("Node.js 20+ must be on PATH")
    with tempfile.TemporaryDirectory(prefix="starfall-pty-") as temporary:
        directory = Path(temporary)
        check_gameplay(directory)
        check_recipes(directory)
        check_shop_and_transmitter(directory)
        check_catalog_navigation(directory)
        check_prestige(directory)
        check_nickname(directory)
        check_demo(directory)
        check_ctrl_c(directory)
        check_dumb_terminal(directory)
        check_sigcont(directory)
        check_suspend_resume(directory)
        check_corrupt_save(directory)
        check_termination_signal(directory)
        check_private_local_mode(directory)
    print("All PTY checks passed.")
