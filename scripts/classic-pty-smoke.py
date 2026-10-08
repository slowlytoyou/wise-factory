#!/usr/bin/env python3
"""Optional POSIX terminal integration checks; Python standard library only.

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
    def __init__(self, directory, *arguments, terminal="xterm-256color"):
        self.master, self.slave = pty.openpty()
        self.original_termios = termios.tcgetattr(self.slave)
        self.resize(110, 38, notify=False)
        self.output = bytearray()
        environment = dict(os.environ, TERM=terminal, XDG_STATE_HOME=str(directory / "state"))
        self.process = subprocess.Popen(
            [NODE, str(ROOT / "src/classic.mjs"), "--no-color", *arguments],
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
        assert b"\x1b[?25h" in output, "Cursor was not restored"
        assert b"\x1b[?7h" in output, "Line wrapping was not restored"
        assert b"\x1b[?1049l" in output, "Alternate screen was not disabled"
        assert termios.tcgetattr(self.slave) == self.original_termios, "Raw terminal settings were not restored"
        assert b"38;2;" not in output, "--no-color emitted RGB color sequences"


def check_gameplay(directory):
    save = directory / "play.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("S T A R F A L L")
        assert not save.exists(), "Startup unexpectedly wrote a save"
        marker = game.send(b"1 ")
        game.expect("별빛 파동", marker)
        marker = game.send(b"p")
        game.expect("일시 정지", marker)
        game.send(b"1 ")  # Both inputs must be ignored while paused.
        marker = game.send(b"?")
        game.expect("FLIGHT MANUAL", marker)
        game.send(b"?")
        game.pump()
        marker = len(game.output)
        game.resize(70, 24)
        game.expect("88열", marker)
        marker = len(game.output)
        game.resize(110, 38)
        game.expect("S T A R F A L L", marker)
        game.finish()
    data = json.loads(save.read_text())
    assert data["levels"] == [1, 0, 0, 0, 0], data
    assert 14 <= data["dust"] < 18, data
    assert 4 <= data["runDust"] < 8, data
    assert data["pulseCooldown"] > 0, data
    assert data["savedAt"] > 0
    print("PASS: purchase, pulse, pause, help, resize, save and terminal restoration")


def check_demo(directory):
    # A read from this FIFO would block forever; starting proves demo skips save reads.
    fifo = directory / "demo-save.fifo"
    os.mkfifo(fifo)
    before = sorted(path.name for path in directory.iterdir())
    with Game(directory, "--demo", "--save", str(fifo)) as game:
        game.expect("DEMO")
        game.finish()
    assert fifo.is_fifo(), "Demo replaced the nominated save"
    assert sorted(path.name for path in directory.iterdir()) == before, "Demo created files"
    print("PASS: demo neither reads nor writes save storage")


def check_ctrl_c(directory):
    save = directory / "interrupt.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("S T A R F A L L")
        marker = game.send(b"1")
        game.expect("Lv.1", marker)
        game.finish(b"\x03")
    assert json.loads(save.read_text())["levels"] == [1, 0, 0, 0, 0]
    print("PASS: Ctrl-C saves progress, restores terminal and exits")


def check_sigcont(directory):
    with Game(directory, "--demo") as game:
        game.expect("DEMO")
        game.process.send_signal(signal.SIGCONT)
        game.pump()
        game.finish()
    print("PASS: unsolicited SIGCONT does not leave an interval keeping the process alive")


def check_suspend_resume(directory):
    save = directory / "suspend.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("S T A R F A L L")
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
        game.pump(0.25)
        marker = len(game.output)
        game.process.send_signal(signal.SIGCONT)
        game.expect("S T A R F A L L", marker)
        assert termios.tcgetattr(game.slave) != game.original_termios
        game.finish()
    after = json.loads(save.read_text())
    assert after["elapsed"] >= before["elapsed"] + 0.2
    assert after["dust"] > before["dust"]
    print("PASS: Ctrl-Z restores the shell, resume restores play and credits suspended production")


def check_corrupt_save(directory):
    save = directory / "corrupt.json"
    original = b"{ this is not valid JSON\n"
    save.write_bytes(original)
    with Game(directory, "--save", str(save)) as game:
        game.expect("저장")
        game.finish(code=1)
    assert save.read_bytes() == original
    assert "저장하지 못했습니다" in game.text()
    print("PASS: damaged save survives shutdown and failed saving still restores the terminal")


def check_termination_signal(directory):
    save = directory / "sigterm.json"
    with Game(directory, "--save", str(save)) as game:
        game.expect("S T A R F A L L")
        game.process.send_signal(signal.SIGTERM)
        game.finish(keys=b"", code=143)
    assert json.loads(save.read_text())["version"] == 1
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


if __name__ == "__main__":
    if NODE is None:
        raise SystemExit("Node.js 20+ must be on PATH")
    with tempfile.TemporaryDirectory(prefix="starfall-pty-") as temporary:
        directory = Path(temporary)
        check_gameplay(directory)
        check_demo(directory)
        check_ctrl_c(directory)
        check_dumb_terminal(directory)
        check_sigcont(directory)
        check_suspend_resume(directory)
        check_corrupt_save(directory)
        check_termination_signal(directory)
    print("All PTY checks passed.")
